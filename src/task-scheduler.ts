import { ChildProcess, execFile as execFileCb } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  createTask,
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<string | undefined>;
  getLastMessageId: (jid: string) => string | undefined;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          // Auto-schedule re-check for reminder-type tasks
          // The agent sends reminders via IPC send_message, so look up
          // the last messageId sent to this chat (captured by the IPC path)
          const isReminder = isReminderTask(task);
          logger.info(
            { taskId: task.id, isReminder, promptPrefix: task.prompt.slice(0, 50) },
            'Task success — checking reminder status',
          );
          if (isReminder) {
            const messageId = deps.getLastMessageId(task.chat_jid);
            if (messageId) {
              scheduleReminderRecheck(task, messageId);
            } else {
              logger.warn(
                { taskId: task.id },
                'Reminder task completed but no messageId found for re-check',
              );
            }
          }
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';

  // Auto-complete interval tasks with scripts when the script returns wakeAgent=false.
  // A null result on a scripted task means the script's condition was met (e.g. user
  // reacted DONE on a reminder). No point checking again — the task is done.
  if (
    task.script &&
    task.schedule_type === 'interval' &&
    !error &&
    !result
  ) {
    logger.info(
      { taskId: task.id },
      'Auto-completing interval task: script condition met (wakeAgent=false)',
    );
    updateTaskAfterRun(task.id, null, 'Auto-completed: condition met');
    return;
  }

  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

const REMINDER_RECHECK_PREFIX = '[REMINDER_RECHECK]';

function isReminderTask(task: ScheduledTask): boolean {
  // Skip tasks that already have a script (they're re-check tasks themselves)
  if (task.script) return false;
  // Use the structured is_reminder flag set by the agent
  return !!task.is_reminder;
}

function isReminderRecheck(task: ScheduledTask): boolean {
  return task.prompt.startsWith(REMINDER_RECHECK_PREFIX);
}

/**
 * Compute re-check delay for a reminder task.
 * Default: 5 minutes. The task prompt can override via keywords:
 *   - "urgent" / "紧急" → 2 min
 *   - "low priority" / "不急" / "不着急" → 30 min
 */
function computeRecheckDelay(task: ScheduledTask): number {
  const prompt = task.prompt.toLowerCase();
  if (/urgent|紧急/.test(prompt)) return 2 * 60_000;
  if (/low.?priority|不急|不着急/.test(prompt)) return 30 * 60_000;
  return 5 * 60_000; // default: 5 minutes
}

function scheduleReminderRecheck(
  task: ScheduledTask,
  messageId: string,
  recheckCount: number = 1,
): void {
  const recheckDelayMs = computeRecheckDelay(task);
  const recheckTime = new Date(Date.now() + recheckDelayMs);
  const recheckMinutes = Math.round(recheckDelayMs / 60_000);
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const promptSnippet = task.prompt
    .replace(REMINDER_RECHECK_PREFIX, '')
    .replace(/\|.*$/, '') // strip previous metadata
    .trim()
    .slice(0, 80)
    .replace(/\n/g, ' ');

  createTask({
    id: taskId,
    group_folder: task.group_folder,
    chat_jid: task.chat_jid,
    prompt: `${REMINDER_RECHECK_PREFIX} ${promptSnippet} | messageId=${messageId} | recheckMinutes=${recheckMinutes} | recheckCount=${recheckCount}`,
    script: `feishu reactions ${messageId} --has DONE && echo '{"wakeAgent":false}' || echo '{"wakeAgent":true,"data":{"message_id":"${messageId}"}}'`,
    is_reminder: false,
    schedule_type: 'once',
    schedule_value: recheckTime.toISOString(),
    context_mode: 'isolated',
    next_run: recheckTime.toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info(
    { taskId, originalTask: task.id, messageId, recheckAt: recheckTime.toISOString() },
    'Auto-scheduled reminder re-check task',
  );
}

/**
 * Handle a reminder re-check entirely at the host level — no agent needed.
 * Runs the feishu reactions script, sends a nudge if not acknowledged,
 * and schedules the next re-check.
 */
async function handleReminderRecheck(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();

  // Extract messageId from prompt (Feishu IDs: om_xxx, but be permissive)
  const msgMatch = task.prompt.match(/messageId=(\S+?)(?:\s|\||$)/);
  if (!msgMatch) {
    logger.error({ taskId: task.id, prompt: task.prompt.slice(0, 200) }, 'Re-check task missing messageId in prompt');
    updateTaskAfterRun(task.id, null, 'Error: missing messageId');
    return;
  }
  const messageId = msgMatch[1];

  // Extract recheck count and enforce max (default max: 48 = ~4 hours at 5 min)
  const countMatch = task.prompt.match(/recheckCount=(\d+)/);
  const recheckCount = countMatch ? parseInt(countMatch[1], 10) : 1;
  const MAX_RECHECKS = 3;
  if (recheckCount > MAX_RECHECKS) {
    logger.info({ taskId: task.id, recheckCount, messageId }, 'Max re-checks reached, stopping');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'success',
      result: `Stopped after ${recheckCount} re-checks`,
      error: null,
    });
    updateTaskAfterRun(task.id, null, `Stopped: max re-checks (${MAX_RECHECKS}) reached`);
    return;
  }

  // Extract chat_id from chat_jid for FEISHU_CHAT_ID env
  const chatId = task.chat_jid.replace(/^feishu:/, '');

  // Build env with feishu script on PATH and required credentials
  const scriptsDir = path.resolve(process.cwd(), 'container', 'scripts');
  const scriptEnv = {
    ...process.env,
    PATH: `${scriptsDir}:${process.env.PATH}`,
    FEISHU_CHAT_ID: chatId,
  };

  // Run the reaction check script
  const execFileAsync = promisify(execFileCb);
  let wakeAgent = true;
  try {
    const { stdout } = await execFileAsync('bash', ['-c', task.script!], {
      timeout: 30_000,
      env: scriptEnv,
    });
    const lines = (stdout || '').trim().split('\n');
    const lastLine = lines[lines.length - 1];
    if (lastLine) {
      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent === 'boolean') wakeAgent = result.wakeAgent;
      } catch { /* not JSON, assume wakeAgent=true */ }
    }
  } catch {
    // Script error (e.g. exit non-zero) — assume not acknowledged
    wakeAgent = true;
  }

  if (!wakeAgent) {
    // User reacted DONE — we're done
    logger.info({ taskId: task.id, messageId }, 'Reminder acknowledged (DONE reaction found)');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'success',
      result: 'Acknowledged',
      error: null,
    });
    updateTaskAfterRun(task.id, null, 'Acknowledged: user reacted DONE');
    return;
  }

  // Not acknowledged — send nudge directly from host
  logger.info({ taskId: task.id, messageId }, 'Reminder not acknowledged, sending nudge');
  try {
    await deps.sendMessage(task.chat_jid, '⏰ 还没完成哦！请在提醒消息上点 ✅ DONE');
  } catch (err) {
    logger.warn({ taskId: task.id, err }, 'Failed to send reminder nudge');
  }

  // Schedule next re-check with incremented count
  scheduleReminderRecheck(task, messageId, recheckCount + 1);

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: 'success',
    result: 'Nudge sent, next re-check scheduled',
    error: null,
  });
  updateTaskAfterRun(task.id, null, 'Nudge sent');
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Reminder re-checks are handled entirely by the host — no agent container needed
        if (isReminderRecheck(currentTask)) {
          handleReminderRecheck(currentTask, deps);
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
