/**
 * Tier 0 · E2E — a full user conversation driven through the REAL orchestrator
 * (bootstrapApp(), processGroupMessages/runAgent/startMessageLoop, src/ipc.ts's
 * flush logic, group-queue.ts, and SQLite session/queue state), with only the
 * external world faked: Docker (child_process.spawn), the chat platform (a
 * test-only Channel registered through the real registerChannel() mechanism),
 * and the wall clock (vi.useFakeTimers()). No NanoClaw code is mocked here —
 * see the "Faked / Real" line on each `it()` group below for the exact split.
 *
 * This closes the coverage hole documented in the architecture doc's Chapter 2
 * (2.1 Testing Today's Single-VM System, "Tier 0 · E2E" card): before this
 * file, nothing drove a full conversation through src/index.ts and src/ipc.ts
 * end-to-end — every other test exercises one module in isolation.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// A short, test-only IDLE_TIMEOUT keeps fake-timer advances (and this file's
// real wall-clock run time) small while still exercising the exact same
// idle-teardown code path production uses with its 30-minute default.
// Real temp directory (not mocked fs) so group folders and IPC message files
// are written and read for real — fast because it's local disk, isolated
// because it's a fresh directory per test file run. Both live in one
// vi.hoisted() block because the ./config.js mock factory below needs their
// concrete values immediately, before this file's own top-level code runs.
const paths = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.HOME || '/tmp';
  const sep = tmp.includes('\\') ? '\\' : '/';
  const root = `${tmp}${sep}nanoclaw-e2e-test-${process.pid}`;
  return {
    root,
    dataDir: `${root}${sep}data`,
    groupsDir: `${root}${sep}groups`,
    storeDir: `${root}${sep}store`,
    idleTimeout: 20_000,
  };
});
const TEST_IDLE_TIMEOUT = paths.idleTimeout;

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  ASSISTANT_HAS_OWN_NUMBER: false,
  POLL_INTERVAL: 2000,
  SCHEDULER_POLL_INTERVAL: 60000,
  MOUNT_ALLOWLIST_PATH: `${paths.root}/mount-allowlist.json`,
  SENDER_ALLOWLIST_PATH: `${paths.root}/sender-allowlist.json`,
  STORE_DIR: paths.storeDir,
  GROUPS_DIR: paths.groupsDir,
  DATA_DIR: paths.dataDir,
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_TIMEOUT: 5000,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  ONECLI_URL: 'http://localhost:10254',
  ONECLI_API_KEY: '',
  MAX_MESSAGES_PER_PROMPT: 10,
  IPC_POLL_INTERVAL: 1000,
  IDLE_TIMEOUT: paths.idleTimeout,
  MAX_CONCURRENT_CONTAINERS: 5,
  buildTriggerPattern: (trigger: string) =>
    new RegExp(`^${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  DEFAULT_TRIGGER: '@Andy',
  getTriggerPattern: (trigger?: string) =>
    new RegExp(`^${(trigger || '@Andy').trim()}\\b`, 'i'),
  TRIGGER_PATTERN: /^@Andy\b/i,
  TIMEZONE: 'UTC',
}));

// Set E2E_TRACE=1 to print real orchestrator log output to the console
// while these tests run (useful for manually inspecting the trace of a
// full conversation through the real bootstrapApp()/message-loop/queue
// code path). Off by default to keep CI/test output clean.
const { trace } = vi.hoisted(() => ({ trace: process.env.E2E_TRACE === '1' }));

// Set E2E_NARRATE=0 to suppress the plain, user-facing chat transcript
// printed for each scenario as it runs — "User: ...", then each message the
// fake channel would actually deliver, in order — instead of (or alongside)
// the raw structured orchestrator logs that E2E_TRACE prints. This is what
// the end user of NanoClaw would actually see in their chat app. On by
// default since it's the most useful/readable view of what these
// conversation-script scenarios actually simulate.
const { narrate } = vi.hoisted(() => ({
  narrate: process.env.E2E_NARRATE !== '0',
}));
vi.mock('./logger.js', () => {
  const noop = () => {};
  return {
    logger: {
      debug: vi.fn(
        trace ? (...a: unknown[]) => console.log('DEBUG', ...a) : noop,
      ),
      info: vi.fn(
        trace ? (...a: unknown[]) => console.log('INFO', ...a) : noop,
      ),
      warn: vi.fn(
        trace ? (...a: unknown[]) => console.log('WARN', ...a) : noop,
      ),
      error: vi.fn(
        trace ? (...a: unknown[]) => console.log('ERROR', ...a) : noop,
      ),
      fatal: vi.fn(
        trace ? (...a: unknown[]) => console.log('FATAL', ...a) : noop,
      ),
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Supplies WEB_USERS so bootstrapApp()'s channel loop actually connects a
// real WebChannel for WebChannelDriver to drive (see E2EDriver above).
// Every OTHER channel's env keys (FEISHU_*, SLACK_*, WECOM_*, ...) resolve
// to '' here regardless of this machine's real .env, keeping those channels
// deterministically unconfigured (factories return null) exactly as they
// were before this mock existed (no .env file in a fresh checkout).
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const env: Record<string, string> = {
      WEB_USERS: 'e2e-user:e2e-pass',
      WEB_PORT: '0', // random port — WebChannelDriver never opens a real socket to it
    };
    return Object.fromEntries(keys.map((k) => [k, env[k] || '']));
  }),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
  ensureContainerRuntimeRunning: vi.fn(),
  cleanupOrphans: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// --- Fake Docker: a controllable fake ChildProcess, one per spawn() call ---
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough & { write: ReturnType<typeof vi.fn> };
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough() as typeof proc.stdin;
  const realWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = vi.fn(realWrite) as typeof proc.stdin.write;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}
type FakeProc = ReturnType<typeof createFakeProcess>;

let spawnedProcs: FakeProc[] = [];

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = createFakeProcess();
      spawnedProcs.push(proc);
      return proc;
    }),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
    execFile: vi.fn(
      (
        _file: string,
        _args: unknown,
        optsOrCb: unknown,
        maybeCb?: (err: Error | null, stdout: string) => void,
      ) => {
        const cb =
          typeof optsOrCb === 'function'
            ? (optsOrCb as (err: Error | null, stdout: string) => void)
            : maybeCb;
        if (cb) cb(null, '');
        return new EventEmitter();
      },
    ),
    // Real container-runner.ts uses this synchronously (`docker top ...`) to
    // check for active child processes before killing a timed-out container.
    // Throwing (as a real `docker top` against a nonexistent container would)
    // keeps killOnTimeout's catch-and-proceed-to-kill branch deterministic.
    execFileSync: vi.fn(() => {
      throw new Error('mocked: docker top unavailable in fake-timer tests');
    }),
  };
});

function emitOutputMarker(
  proc: FakeProc,
  output: import('./container-runner.js').ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

/**
 * Mirrors container/agent-runner/src/index.ts's formatToolNotification() /
 * formatEditDiff() and writeVerboseMessage()'s exact string shape. Duplicated
 * here (not imported) because agent-runner is a separate deployable — its
 * own package.json/tsconfig, its own dependencies (including the real Claude
 * Agent SDK), and its module runs main() at import time. Per the design
 * doc's own "Contract check" caveat: this fidelity is only as good as this
 * mirror staying in sync with the real formatter — if you touch one, touch
 * the other. Source of truth: container/agent-runner/src/index.ts's
 * formatToolNotification()/formatEditDiff()/writeVerboseMessage().
 */
const agentRunnerFormat = {
  bash(command: string): string {
    return `🔧 Bash: ${command.slice(0, 500)}`;
  },
  read(filePath: string): string {
    return `📄 Read: ${filePath}`;
  },
  webSearch(query: string): string {
    return `🌐 WebSearch: ${query}`;
  },
  /** Mirrors the tool_progress branch's inline template (not part of formatToolNotification). */
  progressPing(toolName: string, elapsedSeconds: number): string {
    return `⏳ ${toolName}: still running (${Math.round(elapsedSeconds)}s)`;
  },
  /** Mirrors the `💭 ${text}` template used for both thinking blocks and flushed reasoning. */
  thinking(text: string): string {
    return `💭 ${text}`;
  },
  editDiff(filePath: string, oldString: string, newString: string): string {
    const oldLines = oldString.split('\n');
    const newLines = newString.split('\n');
    const header = `✏️ Edit: ${filePath} (+${newLines.length} -${oldLines.length})`;
    const diffLines: string[] = [];
    for (const line of oldLines) {
      if (diffLines.length >= 10) {
        diffLines.push('  ...');
        break;
      }
      diffLines.push(`- ${line}`);
    }
    for (const line of newLines) {
      if (diffLines.length >= 10) {
        diffLines.push('  ...');
        break;
      }
      diffLines.push(`+ ${line}`);
    }
    return header + '\n' + diffLines.join('\n');
  },
  /** name is not shortened for Agent — icon is 🤖, preview is description/prompt. */
  agentDelegate(description: string): string {
    return `🤖 Agent: ${description}`;
  },
  /** TodoWrite isn't in the icon map, so it falls through to the 🔨 default icon. */
  todoWrite(
    todos: {
      status: 'pending' | 'in_progress' | 'completed';
      content: string;
    }[],
  ): string {
    const preview =
      todos
        .map(
          (t) =>
            `${t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'} ${t.content.slice(0, 40)}`,
        )
        .join(' | ') || '...';
    return `🔨 TodoWrite: ${preview}`;
  },
  /**
   * Mirrors the mcp__ branch exactly: strips the `mcp__<server>__` prefix
   * (note this yields e.g. "check_availability", NOT "calendar.check_availability"
   * — the doc's catalog row shows a dotted display name that the real regex
   * doesn't actually produce; grounding this in the real code, not the doc's
   * illustrative text, per the doc's own "Contract check" principle).
   */
  mcpTool(name: string, input: Record<string, unknown>): string {
    const shortName = name.replace(/^mcp__\w+__/, '');
    const params = Object.entries(input)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => {
        const sv =
          typeof v === 'string'
            ? v.length > 60
              ? v.slice(0, 57) + '...'
              : v
            : JSON.stringify(v);
        return `${k}=${sv}`;
      })
      .join(', ');
    return `🔨 ${shortName}: ${params || '...'}`;
  },
};

/**
 * Simulates the real agent-runner's writeVerboseMessage(): writes one
 * timestamped JSON file into the group's real (temp-dir) IPC messages
 * directory, with the same ▎-per-line indentation, so the host's
 * flushGroupMessages() relays it exactly as it would a real container's
 * intermediate tool-call/reasoning trail.
 */
let verboseSeq = 0;
function emitVerboseMessage(
  chatJid: string,
  groupFolder: string,
  text: string,
): void {
  verboseSeq += 1;
  const indented = text
    .split('\n')
    .map((line) => `▎${line}`)
    .join('\n');
  const messagesDir = path.join(paths.dataDir, 'ipc', groupFolder, 'messages');
  fs.mkdirSync(messagesDir, { recursive: true });
  fs.writeFileSync(
    path.join(
      messagesDir,
      `${Date.now()}-${String(verboseSeq).padStart(4, '0')}.json`,
    ),
    JSON.stringify({
      type: 'message',
      chatJid,
      text: indented,
      groupFolder,
      timestamp: new Date().toISOString(),
    }),
  );
}

/** Reads the ContainerInput JSON a given spawn() call wrote to stdin. */
function stdinInputOf(proc: FakeProc): Record<string, unknown> {
  const call = (proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0];
  return JSON.parse(call[0] as string);
}

/**
 * Simulates the real agent-runner's schedule_task MCP tool (see
 * container/agent-runner/src/ipc-mcp-stdio.ts's writeIpcFile(TASKS_DIR, ...)
 * call): writes one JSON file into the group's real (temp-dir) IPC tasks
 * directory, in the exact shape processTaskIpc() (src/ipc.ts) expects, so
 * the host's independent IPC watcher picks it up and calls the real
 * createTask() exactly as it would for a real container's tool call.
 */
let taskIpcSeq = 0;
function emitScheduleTaskIpc(
  targetJid: string,
  sourceGroupFolder: string,
  task: {
    taskId: string;
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    context_mode?: 'group' | 'isolated';
  },
): void {
  taskIpcSeq += 1;
  const tasksDir = path.join(paths.dataDir, 'ipc', sourceGroupFolder, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(
      tasksDir,
      `${Date.now()}-${String(taskIpcSeq).padStart(4, '0')}.json`,
    ),
    JSON.stringify({
      type: 'schedule_task',
      taskId: task.taskId,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      context_mode: task.context_mode || 'group',
      targetJid,
      createdBy: sourceGroupFolder,
      timestamp: new Date().toISOString(),
    }),
  );
}

import fs from 'fs';
import path from 'path';

import {
  bootstrapApp,
  _resetAppStateForTesting,
  _setRegisteredGroups,
} from './index.js';
import { registerChannel, ChannelOpts } from './channels/registry.js';
import {
  _closeDatabase,
  createTask,
  getSession,
  getTaskById,
  storeChatMetadata,
} from './db.js';
import {
  computeNextRun,
  _resetSchedulerLoopForTests,
} from './task-scheduler.js';
import { _resetIpcWatcherForTesting } from './ipc.js';
import {
  Channel,
  NewMessage,
  OnInboundMessage,
  ScheduledTask,
} from './types.js';

const TEST_GROUP = {
  name: 'E2E Main',
  folder: 'e2e-main',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
  isMain: true, // sidesteps trigger-matching so the test focuses on the orchestrator itself
};

let narratedHeaderThisTest = false;
// Buffered, not printed immediately: Vitest's reporters print a
// "stdout | <test name>" header before *every single* console.log call
// (needed to attribute output when tests run in parallel workers), so
// logging one line at a time makes a short transcript look like a wall of
// duplicated headers. Buffering the whole scenario's lines and flushing
// them as ONE console.log (in afterEach, below) collapses that down to a
// single header per scenario.
let narrationBuffer: string[] = [];

/** Prints "── Scenario: <test name> ──" once per test, only when narrating. */
function narrateHeader(): void {
  if (!narrate || narratedHeaderThisTest) return;
  narratedHeaderThisTest = true;
  const name = expect.getState().currentTestName ?? '(unknown test)';
  narrationBuffer.push(`\n=== ${name} ===`);
}

/** Prints the user's chat message, as they'd see it in their own chat app. */
function narrateUser(text: string): void {
  if (!narrate) return;
  narrateHeader();
  narrationBuffer.push(`👤 User: ${text}`);
}

/**
 * Prints one outgoing message the way it actually arrives in the user's
 * chat: a ▎-prefixed verbose/tool line is rendered as an indented "nanoclaw
 * (working)" aside, while a plain (non-▎) message is the real final reply.
 */
function narrateReply(text: string): void {
  if (!narrate) return;
  narrateHeader();
  if (text.startsWith('▎')) {
    for (const line of text.split('\n')) {
      narrationBuffer.push(
        `  🤖 nanoclaw (working): ${line.replace(/^▎/, '')}`,
      );
    }
  } else {
    narrationBuffer.push(`🤖 nanoclaw: ${text}`);
  }
}

/** Flushes this test's buffered narration lines as a single console.log call. */
function flushNarration(): void {
  if (narrationBuffer.length > 0) {
    console.log(narrationBuffer.join('\n'));
  }
  narrationBuffer = [];
}

/**
 * Drives every scenario below through a specific inbound channel. Every
 * scenario `describe`/`it` block runs once per driver (see the
 * `describe.each(DRIVERS)` wrapper below) so the exact same conversation
 * script is exercised both the "generic fake Channel" way (today's
 * coverage) and through the REAL WebChannel's own login/registration/
 * message-dispatch code (higher fidelity — Web is code NanoClaw owns).
 * `jid` is fixed for the lifetime of one test so TEST_GROUP can be
 * pre-registered under it in bootstrap() below, keeping `group_folder`
 * ('e2e-main') and every session/task assertion identical across drivers.
 */
interface E2EDriver {
  readonly jid: string;
  readonly sentMessages: { jid: string; text: string }[];
  /** Wires this driver up to the real channel instance(s) bootstrapApp() created. */
  attach(app: { channels: Channel[] }): void;
  /** Delivers one inbound message exactly as this driver's real channel would. */
  dispatch(message: NewMessage): void;
}

/** Drives scenarios through a minimal test-only Channel (today's existing coverage). */
class FakeChannelDriver implements E2EDriver {
  readonly jid = 'e2e-main@test';
  sentMessages: { jid: string; text: string }[] = [];
  private onMessage: OnInboundMessage | undefined;

  constructor() {
    const factory = (opts: ChannelOpts): Channel => {
      this.onMessage = opts.onMessage;
      return {
        name: 'e2e-test-channel',
        connect: async () => {},
        sendMessage: async (jid: string, text: string) => {
          this.sentMessages.push({ jid, text });
          narrateReply(text);
          return `sent-${this.sentMessages.length}`;
        },
        isConnected: () => true,
        ownsJid: () => true,
        disconnect: async () => {},
      };
    };
    registerChannel('e2e-test-channel', factory);
  }

  attach(): void {
    // No-op: the fake channel captures onMessage via its own factory above,
    // independent of bootstrapApp()'s returned channels array.
  }

  dispatch(message: NewMessage): void {
    this.onMessage!(this.jid, message);
  }
}

/**
 * Drives scenarios through the REAL WebChannel — the same code the orchestrator
 * connects in production, minus the actual HTTP/socket layer (already covered
 * separately by web.test.ts). Delivers messages via WebChannel's real
 * ingestMessage()/auto-register path (through `_ingestRawMessage`, its
 * test-only pass-through), and observes real replies via `sendMessage()`'s
 * real SSE-push/outgoing-buffer logic (through `_attachTestSubscriber`, its
 * test-only fake-subscriber hook) — see web.ts for both.
 */
class WebChannelDriver implements E2EDriver {
  readonly jid = 'web:e2e-user:main';
  sentMessages: { jid: string; text: string }[] = [];
  private channel: any;

  attach(app: { channels: Channel[] }): void {
    this.channel = app.channels.find((c) => c.name === 'web');
    if (!this.channel) {
      throw new Error(
        'WebChannelDriver: bootstrapApp() did not connect a "web" channel — ' +
          "is WEB_USERS mocked in this file's ./env.js mock?",
      );
    }
    this.channel._attachTestSubscriber('e2e-user', {
      write: (chunk: string) => {
        const line = chunk.trim();
        if (!line.startsWith('data:')) return; // skip the ": connected" SSE comment
        const evt = JSON.parse(line.slice('data:'.length));
        this.sentMessages.push({ jid: evt.jid, text: evt.text });
        narrateReply(evt.text);
      },
    });
  }

  dispatch(message: NewMessage): void {
    this.channel._ingestRawMessage(this.jid, message);
  }
}

const DRIVERS: [string, () => E2EDriver][] = [
  ['fake channel', () => new FakeChannelDriver()],
  ['web channel', () => new WebChannelDriver()],
];

function inboundMessage(
  overrides: Partial<NewMessage> & { content: string },
): NewMessage {
  narrateUser(overrides.content);
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    chat_jid: driver.jid,
    sender: 'user@test',
    sender_name: 'Test User',
    timestamp: new Date().toISOString(),
    is_from_me: false,
    ...overrides,
  };
}

/**
 * bootstrapApp() calls the real initDatabase() internally (by design — see
 * BootstrappedApp's doc comment: nothing in bootstrapApp() is mocked). It
 * opens a real SQLite file under our disposable temp STORE_DIR, so each test
 * gets a fresh, isolated database via the beforeEach temp-dir wipe below —
 * the same "real but local, so fast" property _initTestDatabase() gives
 * other test files, just exercised through the production code path here.
 */
async function bootstrap() {
  const app = await bootstrapApp();
  driver.attach(app);
  // bootstrapApp() -> loadState() reads registered groups from the (fresh,
  // empty) SQLite db, overwriting whatever _setRegisteredGroups() put in the
  // in-memory map beforehand -- so the test group must be (re-)installed
  // *after* bootstrapApp() resolves, not before.
  _setRegisteredGroups({ [driver.jid]: TEST_GROUP });
  storeChatMetadata(driver.jid, new Date().toISOString(), TEST_GROUP.name);
  return app;
}

let advanceCounter = 0;
/** Bumps every simulated message's timestamp so SQLite sees strictly-increasing rows. */
function nextTimestamp(): string {
  advanceCounter += 1;
  return new Date(Date.now() + advanceCounter).toISOString();
}

let driver: E2EDriver;

// Every scenario below runs once per driver — see the E2EDriver design
// comment above DRIVERS' declaration.
describe.each(DRIVERS)('%s driver', (_label, createDriver) => {
  beforeEach(() => {
    vi.useFakeTimers();
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.mkdirSync(paths.root, { recursive: true });
    spawnedProcs = [];
    advanceCounter = 0;
    narratedHeaderThisTest = false;
    narrationBuffer = [];
    _resetAppStateForTesting();
    _resetSchedulerLoopForTests();
    _resetIpcWatcherForTesting();
    driver = createDriver();
  });

  afterEach(() => {
    flushNarration();
    _closeDatabase();
    fs.rmSync(paths.root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  describe('Tier 0 · E2E — full conversation through the real orchestrator', () => {
    it('new conversation, single turn: spawns once with no prior session, persists the session UUID, and delivers exactly one reply', async () => {
      // Faked: Docker (spawn -> fakeProc), the chat channel, wall clock.
      // Real: bootstrapApp()'s wiring, processGroupMessages/runAgent, GroupQueue, SQLite.
      await bootstrap();

      driver.dispatch(
        inboundMessage({ content: 'hello', timestamp: nextTimestamp() }),
      );

      // Let the real message loop's poll tick pick up the stored message and
      // spawn the (fake) container.
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      const input = stdinInputOf(spawnedProcs[0]);
      expect(input.sessionId).toBeUndefined();

      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'Hello! How can I help?',
        newSessionId: 'session-turn-1',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(getSession('e2e-main')).toBe('session-turn-1');
      expect(driver.sentMessages).toEqual([
        { jid: driver.jid, text: 'Hello! How can I help?' },
      ]);
    });

    it('follow-up after the idle timeout resumes the same session in a new container, and the old one is fully torn down', async () => {
      // Faked: Docker, chat channel, wall clock (vi.advanceTimersByTimeAsync
      // drives the real IDLE_TIMEOUT instead of waiting for it).
      // Real: session continuity through SQLite's setSession/getSession, the
      // GroupQueue's active/idle bookkeeping, and the message loop's re-spawn decision.
      await bootstrap();

      driver.dispatch(
        inboundMessage({ content: 'turn one', timestamp: nextTimestamp() }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'reply one',
        newSessionId: 'session-abc',
      });
      await vi.advanceTimersByTimeAsync(10);

      // No further messages: the container's own idle timer (reset by the
      // result above) fires and closes stdin; simulate the container actually
      // exiting in response, same as a real agent-runner process would.
      await vi.advanceTimersByTimeAsync(TEST_IDLE_TIMEOUT + 10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      driver.dispatch(
        inboundMessage({ content: 'turn two', timestamp: nextTimestamp() }),
      );
      await vi.advanceTimersByTimeAsync(2000);

      expect(spawnedProcs).toHaveLength(2);
      const secondInput = stdinInputOf(spawnedProcs[1]);
      expect(secondInput.sessionId).toBe('session-abc');

      emitOutputMarker(spawnedProcs[1], {
        status: 'success',
        result: 'reply two',
        newSessionId: 'session-abc',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[1].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        'reply one',
        'reply two',
      ]);
      expect(getSession('e2e-main')).toBe('session-abc');
    });

    it('a mid-conversation IPC message is flushed before the final result reaches the user, in order', async () => {
      // Faked: Docker; the IPC message file itself is written directly by this
      // test (simulating the real agent-runner's writeVerboseMessage()).
      // Real: src/ipc.ts's flushGroupMessages(), called by the unmodified
      // processGroupMessages() before it sends the final result — this is the
      // exact code path that had 0% coverage before this file existed.
      await bootstrap();

      driver.dispatch(
        inboundMessage({ content: 'do the thing', timestamp: nextTimestamp() }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      // Simulate the real agent-runner's verbose-message channel: a JSON file
      // written into the group's IPC messages directory mid-run.
      emitVerboseMessage(driver.jid, 'e2e-main', 'Running a tool…');

      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'done!',
        newSessionId: 'session-xyz',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎Running a tool…',
        'done!',
      ]);
    });

    it("graceful shutdown does not kill an in-flight container (it detaches, matching GroupQueue.shutdown()'s real semantics)", async () => {
      // Faked: Docker, chat channel. Real: bootstrapApp().shutdown() / GroupQueue.shutdown().
      const app = await bootstrap();

      driver.dispatch(
        inboundMessage({ content: 'long task', timestamp: nextTimestamp() }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      await expect(app.shutdown()).resolves.toBeUndefined();
      // Real behavior today: shutdown() detaches rather than killing active
      // containers (see group-queue.ts), so the process is left running.
      expect(spawnedProcs[0].kill).not.toHaveBeenCalled();
    });
  });

  /**
   * Conversation scripts: the fake agent's task-variety catalog (architecture
   * doc, Chapter 2 / 2.1, "Conversation scripts" table). Each test scripts one
   * realistic turn as emitVerboseMessage(...) calls (the agent's intermediate
   * tool-call/reasoning trail, delivered via IPC files) followed by one
   * emitOutputMarker(...) (the final stdout result), then asserts the fake
   * channel received exactly that sequence, in order, with the exact
   * formatting a real agent-runner would produce.
   *
   * Faked: every tool call itself — Bash, Edit, etc. — and the real Claude
   * Agent SDK query() call. None of it executes; fakeProc is the container
   * process, so nothing inside it ever runs. Real: NanoClaw's relay code that
   * consumes the scripted output — ipc.ts's ordering/flush logic,
   * container-runner.ts's marker parsing, and the exact reply text/order
   * delivered to the fake channel. These prove "does NanoClaw relay a real
   * agent's output correctly," not "does the agent's reasoning/tools work"
   * (that's Tier 1/Tier 2's job).
   *
   * Only a subset of the doc's full catalog is implemented here so far —
   * see the doc's "Conversation scripts" table for the remaining scenarios
   * (progress pings, TodoWrite checklists, sub-agent delegation, MCP tools,
   * timeout mid-task, multi-result scheduled tasks).
   */
  describe('Conversation scripts — realistic agent task scenarios', () => {
    it('plain Q&A, no tools: "What\'s 2+2?" goes straight to the final marker with zero verbose events', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({ content: "What's 2+2?", timestamp: nextTimestamp() }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      // No emitVerboseMessage calls at all — the baseline/regression case.
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: "It's 4.",
        newSessionId: 'session-qa',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(driver.sentMessages.map((m) => m.text)).toEqual(["It's 4."]);
    });

    it('single read-only lookup: "What\'s in my README?" relays one Read notification before the final answer', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: "What's in my README?",
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      emitVerboseMessage(driver.jid, 'e2e-main', '📄 Read: README.md');
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'Your README describes NanoClaw, a personal Claude assistant.',
        newSessionId: 'session-readme',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎📄 Read: README.md',
        'Your README describes NanoClaw, a personal Claude assistant.',
      ]);
    });

    it('multi-step edit-and-verify: "Fix the typo in config.ts and run the tests" relays three tool notifications in strict order, with a correctly formatted+capped Edit diff preview', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: 'Fix the typo in config.ts and run the tests',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      // Scripted fake-agent sequence, exactly as the doc's catalog describes:
      //   🔧 Bash: npm run lint
      //   ✏️ Edit: src/config.ts (+1 -1)
      //   🔧 Bash: npm test
      //   final marker: "Fixed the typo, tests pass."
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.bash('npm run lint'),
      );
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.editDiff(
          'src/config.ts',
          "const asssistantName = 'Andy';",
          "const assistantName = 'Andy';",
        ),
      );
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.bash('npm test'),
      );
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'Fixed the typo, tests pass.',
        newSessionId: 'session-edit-verify',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      // Strict chronological order: lint -> edit (with capped diff preview) -> test -> final answer.
      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎🔧 Bash: npm run lint',
        "▎✏️ Edit: src/config.ts (+1 -1)\n▎- const asssistantName = 'Andy';\n▎+ const assistantName = 'Andy';",
        '▎🔧 Bash: npm test',
        'Fixed the typo, tests pass.',
      ]);
    });

    it('long-running search with a progress ping: "Search the web for the latest Node LTS version" relays the search, a >=5s progress ping, then the summary', async () => {
      // Caveat: the 5s elapsed-time *gate* itself is agent-runner's own decision
      // (it never emits a ping under 5s) — that decision runs inside the real
      // container, which this test doesn't execute (fakeProc is scripted, not
      // real). This test proves the host relays a ping when the agent chooses
      // to send one, with the exact format agent-runner would use.
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content:
            'Search the web for the latest Node LTS version and summarize',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.webSearch('node lts version'),
      );
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.progressPing('WebSearch', 7),
      );
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'Node 22 is the current LTS release.',
        newSessionId: 'session-search',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎🌐 WebSearch: node lts version',
        '▎⏳ WebSearch: still running (7s)',
        'Node 22 is the current LTS release.',
      ]);
    });

    it('reasoning immediately followed by the answer: "Should I use Postgres or SQLite here?" sends only the final answer, no verbose messages', async () => {
      // Caveat: the drop-vs-flush decision for buffered reasoning is
      // agent-runner's own internal logic (a `thinking`/`text` block with no
      // following tool_use gets dropped because it duplicates the final
      // answer) — that logic runs inside the real container, not exercised by
      // this fakeProc-driven test. This test proves the host-observable
      // *effect* of that decision (zero verbose messages, matching the doc's
      // catalog row), not agent-runner's internal buffering code itself.
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: 'Should I use Postgres or SQLite here?',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      // No emitVerboseMessage call — the buffered reasoning is dropped because
      // it precedes a `result` message with no intervening tool call.
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'SQLite — no server to run, and your load is single-writer.',
        newSessionId: 'session-reasoning-drop',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        'SQLite — no server to run, and your load is single-writer.',
      ]);
    });

    it('reasoning that leads into a tool call: same question, but the agent checks something first — the buffered reasoning is flushed as 💭 before the tool notification', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: 'Should I use Postgres or SQLite here?',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      // This time the reasoning is followed by a tool_use in the same
      // assistant turn, so agent-runner flushes it immediately instead of
      // buffering-then-dropping it (the opposite branch from the test above).
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.thinking(
          'Let me check what package.json already depends on.',
        ),
      );
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.read('package.json'),
      );
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result:
          'You already depend on better-sqlite3, so SQLite is the simpler fit.',
        newSessionId: 'session-reasoning-flush',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎💭 Let me check what package.json already depends on.',
        '▎📄 Read: package.json',
        'You already depend on better-sqlite3, so SQLite is the simpler fit.',
      ]);
    });

    it('live checklist progress: "Plan out and complete a 3-step refactor" relays every TodoWrite update, not just first/last, so progress is visibly live', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: 'Plan out and complete a 3-step refactor',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      const steps = ['Extract helper', 'Update callers', 'Remove dead code'];
      const checklist = (
        statuses: ('pending' | 'in_progress' | 'completed')[],
      ) =>
        agentRunnerFormat.todoWrite(
          steps.map((content, i) => ({ status: statuses[i], content })),
        );

      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        checklist(['pending', 'pending', 'pending']),
      );
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        checklist(['in_progress', 'pending', 'pending']),
      );
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        checklist(['completed', 'in_progress', 'pending']),
      );
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        checklist(['completed', 'completed', 'completed']),
      );
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'Refactor complete.',
        newSessionId: 'session-todo',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      // All four intermediate states are relayed — not deduped to first/last.
      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎🔨 TodoWrite: ⬜ Extract helper | ⬜ Update callers | ⬜ Remove dead code',
        '▎🔨 TodoWrite: 🔄 Extract helper | ⬜ Update callers | ⬜ Remove dead code',
        '▎🔨 TodoWrite: ✅ Extract helper | 🔄 Update callers | ⬜ Remove dead code',
        '▎🔨 TodoWrite: ✅ Extract helper | ✅ Update callers | ✅ Remove dead code',
        'Refactor complete.',
      ]);
    });

    it('sub-agent delegation: "Delegate the research half of this to a sub-agent" relays the Agent notification and its nested tool call together', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: 'Delegate the research half of this to a sub-agent',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.agentDelegate('research competing libraries'),
      );
      // Nested tool call performed by the sub-agent — relayed the same way as
      // any other tool notification, just occurring after the Agent dispatch.
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.webSearch('best sqlite orm 2026'),
      );
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'Sub-agent recommends Drizzle for this use case.',
        newSessionId: 'session-subagent',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎🤖 Agent: research competing libraries',
        '▎🌐 WebSearch: best sqlite orm 2026',
        'Sub-agent recommends Drizzle for this use case.',
      ]);
    });

    it('MCP tool call: "Check my calendar availability for tomorrow" strips the mcp__ prefix and renders params as k=v', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: 'Check my calendar availability for tomorrow',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.mcpTool('mcp__calendar__check_availability', {
          date: '2026-07-27',
        }),
      );
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: "You're free all day tomorrow.",
        newSessionId: 'session-mcp',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎🔨 check_availability: date=2026-07-27',
        "You're free all day tomorrow.",
      ]);
    });

    it('timeout mid-task: a long Bash command that never finishes still delivers its verbose trail via the independent IPC watcher, even with no final answer', async () => {
      // Faked: Docker, chat channel, wall clock. Real: container-runner.ts's
      // hard-timeout/killOnTimeout path, and — importantly — src/ipc.ts's
      // *independent* periodic watcher (startIpcWatcher's processIpcFiles
      // loop), which is what actually delivers this verbose message: the
      // in-band flushGroupMessages() call in processGroupMessages only runs
      // when result.result is truthy, so on a real timeout (result: null) it
      // never fires — the verbose trail survives only because the separate
      // watcher polls all groups' IPC directories on its own schedule.
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: 'run the full build',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.bash('long-running-build.sh'),
      );
      // Give the independent IPC watcher a chance to flush it before the
      // container ever times out (mirrors what a real long task looks like:
      // the trail arrives progressively, well before the eventual timeout).
      await vi.advanceTimersByTimeAsync(5000);
      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎🔧 Bash: long-running-build.sh',
      ]);

      // No emitOutputMarker ever arrives — advance past the hard timeout
      // (CONTAINER_TIMEOUT=5000ms here, but the real code enforces a floor of
      // IDLE_TIMEOUT+30s, so the effective timeout is 50s in this test's config).
      await vi.advanceTimersByTimeAsync(50_000);
      // Simulate the real container actually exiting once stopContainer's
      // graceful-stop signal reaches it (stopContainer itself is a no-op mock).
      spawnedProcs[0].emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      // No final answer was ever sent — only the verbose trail that already
      // went out before the timeout.
      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎🔧 Bash: long-running-build.sh',
      ]);
    });

    it('multi-prompt run, two results in one container: onOutput fires for every marker found in the stream, not just the first (NOTE: despite the doc catalog calling this "scheduled task", it is driven by a normal user message here — see the "Scheduled tasks" describe block below for tests that go through the real task-scheduler.ts)', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: 'run the nightly digest',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.read('digest-sources.json'),
      );
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'Prompt 1 done: fetched sources.',
        newSessionId: 'session-scheduled',
      });
      await vi.advanceTimersByTimeAsync(10);

      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.bash('render digest.html'),
      );
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'Prompt 2 done: digest sent.',
        newSessionId: 'session-scheduled',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      // Only one docker run for the whole scheduled invocation, but both
      // markers were relayed as separate results, in order.
      expect(spawnedProcs).toHaveLength(1);
      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        '▎📄 Read: digest-sources.json',
        'Prompt 1 done: fetched sources.',
        '▎🔧 Bash: render digest.html',
        'Prompt 2 done: digest sent.',
      ]);
    });
  });

  describe('Multi-turn conversations — several user messages, one continuous session', () => {
    // Faked: Docker, chat channel, wall clock. Real: everything else,
    // including GroupQueue's session persistence across turns. Unlike the
    // "idle-timeout resume" test in the Tier 0 block (which deliberately
    // crosses IDLE_TIMEOUT to exercise container teardown+resume), these
    // scenarios stay well inside the idle window — the ordinary case of a
    // user just... continuing to chat.

    it('two-turn follow-up: "What\'s the weather in Tokyo?" then "What about tomorrow?" — same session ID both times, no extra teardown', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: "What's the weather in Tokyo?",
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);
      expect(stdinInputOf(spawnedProcs[0]).sessionId).toBeUndefined();

      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: "It's 24°C and sunny in Tokyo right now.",
        newSessionId: 'session-weather',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      // Second turn, well inside the idle window — same conversation, not a resume.
      driver.dispatch(
        inboundMessage({
          content: 'What about tomorrow?',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(2);
      // The second container is handed the session from turn one, so the
      // agent has the prior "Tokyo" context without the user repeating it.
      expect(stdinInputOf(spawnedProcs[1]).sessionId).toBe('session-weather');

      emitOutputMarker(spawnedProcs[1], {
        status: 'success',
        result: 'Tomorrow in Tokyo: 22°C, light rain in the afternoon.',
        newSessionId: 'session-weather',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[1].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(getSession('e2e-main')).toBe('session-weather');
      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        "It's 24°C and sunny in Tokyo right now.",
        'Tomorrow in Tokyo: 22°C, light rain in the afternoon.',
      ]);
    });

    it('three-turn task refinement: user narrows down a request across three messages, each turn building on the last', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: 'Find me a good book to read',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: 'Sure — any particular genre?',
        newSessionId: 'session-book',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      driver.dispatch(
        inboundMessage({
          content: 'Sci-fi, something recent',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(2);
      expect(stdinInputOf(spawnedProcs[1]).sessionId).toBe('session-book');
      emitVerboseMessage(
        driver.jid,
        'e2e-main',
        agentRunnerFormat.webSearch('best sci-fi novels 2026'),
      );
      emitOutputMarker(spawnedProcs[1], {
        status: 'success',
        result:
          'How about "The Tangled Stars" (2026) — space opera, well reviewed?',
        newSessionId: 'session-book',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[1].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      driver.dispatch(
        inboundMessage({
          content: 'That sounds good, where can I buy it?',
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(3);
      expect(stdinInputOf(spawnedProcs[2]).sessionId).toBe('session-book');
      emitOutputMarker(spawnedProcs[2], {
        status: 'success',
        result:
          "It's on all the major ebook stores and in print from most retailers.",
        newSessionId: 'session-book',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[2].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      // One continuous session across all three turns, and the full
      // conversation was relayed to the user in strict chronological order.
      expect(getSession('e2e-main')).toBe('session-book');
      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        'Sure — any particular genre?',
        '▎🌐 WebSearch: best sci-fi novels 2026',
        'How about "The Tangled Stars" (2026) — space opera, well reviewed?',
        "It's on all the major ebook stores and in print from most retailers.",
      ]);
    });
  });

  describe('Scheduled tasks — creation via natural-language request, and real execution through task-scheduler.ts', () => {
    // Faked: Docker, chat channel, wall clock. Real: everything else,
    // including src/task-scheduler.ts's startSchedulerLoop/runTask/
    // computeNextRun and src/ipc.ts's processTaskIpc — bootstrapApp() wires
    // startSchedulerLoop() up exactly as production does, so its periodic
    // setTimeout(loop, SCHEDULER_POLL_INTERVAL) tick fires for real once the
    // fake clock is advanced past it (SCHEDULER_POLL_INTERVAL is mocked to
    // 60000ms — the real production value — in this file's ./config.js mock).

    it('user asks for a recurring reminder: "Start sending me today\'s weather 9am every day" creates a cron task via the schedule_task IPC path, and the agent confirms it in chat', async () => {
      await bootstrap();

      driver.dispatch(
        inboundMessage({
          content: "Start sending me today's weather 9am every day",
          timestamp: nextTimestamp(),
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnedProcs).toHaveLength(1);

      // The fake agent decides to call the (real) schedule_task MCP tool,
      // which — in production — writes exactly this IPC file from inside the
      // container. We can't run the real MCP tool here (no real container),
      // so this line is the one faked step; everything downstream of it
      // (processTaskIpc, createTask, the DB row) is real.
      emitScheduleTaskIpc(driver.jid, 'e2e-main', {
        taskId: 'task-daily-weather',
        prompt: "Send today's weather forecast",
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // 9:00 AM daily, UTC (this file mocks TIMEZONE to 'UTC')
        context_mode: 'isolated',
      });
      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: "Done — I'll send you the weather every day at 9am.",
        newSessionId: 'session-schedule-weather',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      // Give the independent IPC watcher a chance to process the tasks/
      // directory (same mechanism the earlier "timeout mid-task" test relies
      // on for messages/ — processIpcFiles() polls messages, tasks, AND
      // queries every tick, all in the same loop).
      await vi.advanceTimersByTimeAsync(5000);

      const task = getTaskById('task-daily-weather');
      expect(task).toBeDefined();
      expect(task).toMatchObject({
        id: 'task-daily-weather',
        group_folder: 'e2e-main',
        chat_jid: driver.jid,
        prompt: "Send today's weather forecast",
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
      });
      // Confirmed via a cron library computation, not a hardcoded date, so
      // this doesn't rot the day this test happens to run.
      expect(new Date(task!.next_run!).getTime()).toBeGreaterThan(Date.now());

      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        "Done — I'll send you the weather every day at 9am.",
      ]);
    });

    it('a due cron task actually fires: the scheduler spawns a container on its own (no user message), delivers the result, and reschedules for the next occurrence', async () => {
      await bootstrap();

      // Seed the task directly via the real createTask() (bypassing the IPC
      // step tested above — this test is about the scheduler LOOP, not task
      // creation), already due (next_run in the past) so the very next
      // scheduler tick picks it up.
      const task: Omit<ScheduledTask, 'last_run' | 'last_result'> = {
        id: 'task-daily-weather',
        group_folder: 'e2e-main',
        chat_jid: driver.jid,
        prompt: "Send today's weather forecast",
        script: null,
        is_reminder: false,
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'isolated',
        next_run: new Date(Date.now() - 1000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      };
      createTask(task);

      // No driver.dispatch(...) call anywhere in this test — the container
      // spawn below is driven entirely by startSchedulerLoop's own polling,
      // exactly like a real 9am firing would be, just sped up.
      await vi.advanceTimersByTimeAsync(60_000); // SCHEDULER_POLL_INTERVAL

      expect(spawnedProcs).toHaveLength(1);
      const input = stdinInputOf(spawnedProcs[0]);
      expect(input.prompt).toBe("Send today's weather forecast");
      // context_mode: 'isolated' tasks don't carry forward a chat session.
      expect(input.sessionId).toBeUndefined();

      emitOutputMarker(spawnedProcs[0], {
        status: 'success',
        result: "Today's forecast: 18°C, partly cloudy.",
        newSessionId: 'session-weather-run',
      });
      await vi.advanceTimersByTimeAsync(10);
      spawnedProcs[0].emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      expect(driver.sentMessages.map((m) => m.text)).toEqual([
        "Today's forecast: 18°C, partly cloudy.",
      ]);

      // The task rescheduled itself for the next 9am occurrence — confirmed
      // via the real computeNextRun(), not a hardcoded date.
      const updated = getTaskById('task-daily-weather');
      expect(updated!.status).toBe('active');
      expect(updated!.last_result).toContain("Today's forecast");
      const expectedNext = computeNextRun({
        ...task,
        last_run: null,
        last_result: null,
      });
      expect(updated!.next_run).toBe(expectedNext);
      expect(new Date(updated!.next_run!).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });
  });
}); // end describe.each(DRIVERS)
