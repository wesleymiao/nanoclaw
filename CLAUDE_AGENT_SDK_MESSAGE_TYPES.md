# Claude Agent SDK (@anthropic-ai/claude-agent-sdk) - Complete Message Types Report

**SDK Version Analyzed:** 0.2.92  
**Installation Date:** April 18, 2026  
**Generated from:** TypeScript type definitions in `sdk.d.ts`

---

## Table of Contents

1. [Overview](#overview)
2. [Message Type Union](#message-type-union)
3. [Complete Message Type Definitions](#complete-message-type-definitions)
4. [Event Categories](#event-categories)
5. [Tool Use Events](#tool-use-events)
6. [System Events](#system-events)
7. [Result Messages](#result-messages)
8. [Hook Events](#hook-events)

---

## Overview

The Claude Agent SDK emits messages through an async iterable interface. All messages are part of the union type **`SDKMessage`** which aggregates all possible message types the SDK can emit.

The SDK is used in NanoClaw's agent-runner via the `query()` function:
```typescript
for await (const message of query({...})) {
  // message is of type SDKMessage
}
```

---

## Message Type Union

### SDKMessage (Master Union Type)

```typescript
export declare type SDKMessage = 
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage              // Union of SDKResultSuccess | SDKResultError
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKAPIRetryMessage
  | SDKLocalCommandOutputMessage
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKToolProgressMessage
  | SDKAuthStatusMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKSessionStateChangedMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
  | SDKRateLimitEvent
  | SDKElicitationCompleteMessage
  | SDKPromptSuggestionMessage;
```

---

## Complete Message Type Definitions

### Assistant Messages

#### SDKAssistantMessage
```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  message: BetaMessage;                    // Anthropic SDK's BetaMessage
  parent_tool_use_id: string | null;       // Links to parent tool if nested
  error?: SDKAssistantMessageError;        // Error type if applicable
  uuid: UUID;
  session_id: string;
};
```

**Subtype Values:** N/A (main `type` is 'assistant')

**Content:** Contains the assistant's response with `content` blocks that may include:
- `type: 'text'` - Text responses
- `type: 'tool_use'` - Tool invocations with `id`, `name`, and `input`

---

#### SDKPartialAssistantMessage
```typescript
type SDKPartialAssistantMessage = {
  type: 'stream_event';
  event: BetaRawMessageStreamEvent;        // Raw streaming event from Anthropic SDK
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
};
```

**Purpose:** Emitted during assistant response streaming (delta events, usage updates, etc.)

---

### User Messages

#### SDKUserMessage
```typescript
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;                   // Anthropic SDK's MessageParam
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;                   // True if auto-generated
  tool_use_result?: unknown;                // Result from a tool execution
  priority?: 'now' | 'next' | 'later';     // Message priority
  timestamp?: string;                       // ISO 8601 timestamp
  uuid?: UUID;
  session_id?: string;
};
```

**Purpose:** Represents user input or synthetic messages injected by the system.

---

#### SDKUserMessageReplay
```typescript
type SDKUserMessageReplay = {
  type: 'user';
  message: MessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  priority?: 'now' | 'next' | 'later';
  timestamp?: string;
  uuid: UUID;                               // Required (not optional)
  session_id: string;                       // Required (not optional)
  isReplay: true;                           // Key distinguisher
  file_attachments?: unknown[];             // File attachments if any
};
```

**Purpose:** Replayed messages from session history (when resuming sessions).

---

### Result Messages

#### SDKResultSuccess
```typescript
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  duration_ms: number;                     // Total execution time
  duration_api_ms: number;                 // Time spent in API calls
  is_error: false;
  num_turns: number;                       // Number of agent turns
  result: string;                          // Final text result
  stop_reason: string | null;
  total_cost_usd: number;
  usage: NonNullableUsage;                 // Token usage breakdown
  modelUsage: Record<string, ModelUsage>;  // Per-model usage
  permission_denials: SDKPermissionDenial[];
  structured_output?: unknown;              // JSON output if schema specified
  deferred_tool_use?: SDKDeferredToolUse;   // Incomplete tool use
  terminal_reason?: TerminalReason;
  fast_mode_state?: FastModeState;
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'success'`

---

#### SDKResultError
```typescript
type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  duration_ms: number;
  duration_api_ms: number;
  is_error: true;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  errors: string[];                        // Error messages
  terminal_reason?: TerminalReason;
  fast_mode_state?: FastModeState;
  uuid: UUID;
  session_id: string;
};
```

**Subtypes:**
- `'error_during_execution'` - Exception during execution
- `'error_max_turns'` - Maximum turns exceeded
- `'error_max_budget_usd'` - Budget limit exceeded
- `'error_max_structured_output_retries'` - Output retry limit exceeded

---

### Tool Use Events

#### SDKToolProgressMessage
```typescript
type SDKToolProgressMessage = {
  type: 'tool_progress';
  tool_use_id: string;                     // Unique ID for this tool invocation
  tool_name: string;                       // Name of the tool (e.g., 'Bash', 'Read')
  parent_tool_use_id: string | null;       // Parent if nested
  elapsed_time_seconds: number;
  task_id?: string;                        // If part of a background task
  uuid: UUID;
  session_id: string;
};
```

**Purpose:** Emitted periodically during tool execution to show progress.

**Tools Supported (from agent-runner):**
- `Bash` - Execute shell commands
- `Read` - Read files
- `Write` - Write files
- `Edit` - Edit files
- `Glob` - Pattern-based file matching
- `Grep` - Text search in files
- `WebSearch` - Web search
- `WebFetch` - Fetch web content
- `Task` - Task management
- `TaskOutput` / `TaskStop` - Task control
- `TeamCreate` / `TeamDelete` - Agent team control
- `SendMessage` - Send messages
- `TodoWrite` - Todo list management
- `ToolSearch` - Search for tools
- `Skill` - Invoke skills
- `NotebookEdit` - Edit notebooks
- `mcp__nanoclaw__*` - Custom MCP tools

---

#### SDKToolUseSummaryMessage
```typescript
type SDKToolUseSummaryMessage = {
  type: 'tool_use_summary';
  summary: string;                         // Natural language summary
  preceding_tool_use_ids: string[];        // IDs of tools being summarized
  uuid: UUID;
  session_id: string;
};
```

**Purpose:** High-level summary of multiple tool uses that have completed.

---

### System Messages

#### SDKSystemMessage (Initialization)
```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  agents?: string[];                       // Available subagents
  apiKeySource: ApiKeySource;              // Auth source
  betas?: string[];                        // Enabled beta features
  claude_code_version: string;
  cwd: string;                             // Working directory
  tools: string[];                         // Available tools
  mcp_servers: Array<{
    name: string;
    status: string;
  }>;
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];                // Available commands
  output_style: string;
  skills: string[];                        // Loaded skills
  plugins: Array<{
    name: string;
    path: string;
  }>;
  fast_mode_state?: FastModeState;
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'init'`  
**Timing:** First message after session initialization

---

#### SDKStatusMessage
```typescript
type SDKStatusMessage = {
  type: 'system';
  subtype: 'status';
  status: SDKStatus;                       // 'compacting' | null
  permissionMode?: PermissionMode;
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'status'`  
**Purpose:** Status updates (e.g., when context compaction is occurring)

---

#### SDKAPIRetryMessage
```typescript
type SDKAPIRetryMessage = {
  type: 'system';
  subtype: 'api_retry';
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: SDKAssistantMessageError;         // Specific error type
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'api_retry'`  
**Error Types:**
- `'authentication_failed'`
- `'billing_error'`
- `'rate_limit'`
- `'invalid_request'`
- `'server_error'`
- `'unknown'`
- `'max_output_tokens'`

---

#### SDKCompactBoundaryMessage
```typescript
type SDKCompactBoundaryMessage = {
  type: 'system';
  subtype: 'compact_boundary';
  compact_metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
    preserved_segment?: {
      head_uuid: UUID;
      anchor_uuid: UUID;
      tail_uuid: UUID;
    };
  };
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'compact_boundary'`  
**Purpose:** Marks context compaction boundaries in transcript

---

#### SDKSessionStateChangedMessage
```typescript
type SDKSessionStateChangedMessage = {
  type: 'system';
  subtype: 'session_state_changed';
  state: 'idle' | 'running' | 'requires_action';
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'session_state_changed'`  
**States:**
- `'idle'` - Agent not processing (fires after result flushes)
- `'running'` - Agent processing
- `'requires_action'` - Waiting for user/external action

---

#### SDKAuthStatusMessage
```typescript
type SDKAuthStatusMessage = {
  type: 'auth_status';
  isAuthenticating: boolean;
  output: string[];                        // Auth output lines
  error?: string;
  uuid: UUID;
  session_id: string;
};
```

**Purpose:** Authentication status updates (login, token refresh, etc.)

---

#### SDKLocalCommandOutputMessage
```typescript
type SDKLocalCommandOutputMessage = {
  type: 'system';
  subtype: 'local_command_output';
  content: string;                         // Output text
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'local_command_output'`  
**Purpose:** Output from local slash commands (e.g., `/voice`, `/cost`)

---

### Task Events

#### SDKTaskStartedMessage
```typescript
type SDKTaskStartedMessage = {
  type: 'system';
  subtype: 'task_started';
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;
  workflow_name?: string;                  // From workflow script meta.name
  prompt?: string;
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'task_started'`  
**Task Types:** `'local_workflow'` (and others)

---

#### SDKTaskProgressMessage
```typescript
type SDKTaskProgressMessage = {
  type: 'system';
  subtype: 'task_progress';
  task_id: string;
  tool_use_id?: string;
  description: string;
  usage: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  last_tool_name?: string;
  summary?: string;
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'task_progress'`  
**Purpose:** Periodic progress updates during task execution

---

#### SDKTaskNotificationMessage
```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;                    // Path to task output
  summary: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'task_notification'`  
**Purpose:** Final status notification when task completes/fails/stops

---

### Hook Events

#### SDKHookStartedMessage
```typescript
type SDKHookStartedMessage = {
  type: 'system';
  subtype: 'hook_started';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'hook_started'`  
**Purpose:** Signal that a hook is starting execution

---

#### SDKHookProgressMessage
```typescript
type SDKHookProgressMessage = {
  type: 'system';
  subtype: 'hook_progress';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string;
  stderr: string;
  output: string;
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'hook_progress'`  
**Purpose:** Periodic output from hook execution

---

#### SDKHookResponseMessage
```typescript
type SDKHookResponseMessage = {
  type: 'system';
  subtype: 'hook_response';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: 'success' | 'error' | 'cancelled';
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'hook_response'`  
**Purpose:** Final result when hook completes

---

### File & Persistence Events

#### SDKFilesPersistedEvent
```typescript
type SDKFilesPersistedEvent = {
  type: 'system';
  subtype: 'files_persisted';
  files: Array<{
    filename: string;
    file_id: string;
  }>;
  failed: Array<{
    filename: string;
    error: string;
  }>;
  processed_at: string;
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'files_persisted'`  
**Purpose:** Notification after file operations complete

---

### Rate Limiting & Elicitation

#### SDKRateLimitEvent
```typescript
type SDKRateLimitEvent = {
  type: 'rate_limit_event';
  rate_limit_info: SDKRateLimitInfo;
  uuid: UUID;
  session_id: string;
};

type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
};
```

**Purpose:** Rate limit information for claude.ai subscription users

---

#### SDKElicitationCompleteMessage
```typescript
type SDKElicitationCompleteMessage = {
  type: 'system';
  subtype: 'elicitation_complete';
  mcp_server_name: string;
  elicitation_id: string;
  uuid: UUID;
  session_id: string;
};
```

**Subtype:** `'elicitation_complete'`  
**Purpose:** MCP server confirms URL-mode elicitation (user input request) is complete

---

### Utility Messages

#### SDKPromptSuggestionMessage
```typescript
type SDKPromptSuggestionMessage = {
  type: 'prompt_suggestion';
  suggestion: string;                     // Predicted next prompt
  uuid: UUID;
  session_id: string;
};
```

**Purpose:** Emitted after each turn when `promptSuggestions: true` in options

---

## Event Categories

### By Frequency / Importance

#### High-Frequency Messages (Expect Often)
- `SDKAssistantMessage` - Each Claude response
- `SDKPartialAssistantMessage` - Streaming chunks during response
- `SDKToolProgressMessage` - Every few seconds during tool execution
- `SDKUserMessage` - Each user input
- `SDKResultMessage` - One per query completion (success or error)

#### Medium-Frequency Messages (Expect Sometimes)
- `SDKSystemMessage` - Once at session init
- `SDKStatusMessage` - During context compaction
- `SDKTaskProgressMessage` - During background task execution
- `SDKTaskNotificationMessage` - After task completion
- `SDKToolUseSummaryMessage` - Grouped summaries of tool uses

#### Low-Frequency Messages (Expect Rarely)
- `SDKAPIRetryMessage` - Only on API errors
- `SDKAuthStatusMessage` - Authentication events
- `SDKCompactBoundaryMessage` - On context compaction
- `SDKSessionStateChangedMessage` - State transitions
- `SDKFilesPersistedEvent` - After persistence operations
- `SDKHookStartedMessage`, `SDKHookProgressMessage`, `SDKHookResponseMessage` - Hook lifecycle
- `SDKRateLimitEvent` - Rate limit changes
- `SDKElicitationCompleteMessage` - MCP elicitation completions
- `SDKPromptSuggestionMessage` - If suggestions enabled
- `SDKLocalCommandOutputMessage` - Local command output

---

## How NanoClaw Uses These Messages

From `/home/azureuser/nanoclaw/container/agent-runner/src/index.ts`:

```typescript
for await (const message of query({...})) {
  const msgType =
    message.type === 'system'
      ? `system/${(message as { subtype?: string }).subtype}`
      : message.type;
  log(`[msg #${messageCount}] type=${msgType}`);

  if (message.type === 'assistant' && 'uuid' in message) {
    lastAssistantUuid = (message as { uuid: string }).uuid;
  }

  if (message.type === 'system' && message.subtype === 'init') {
    newSessionId = message.session_id;
    log(`Session initialized: ${newSessionId}`);
  }

  if (
    message.type === 'system' &&
    (message as { subtype?: string }).subtype === 'task_notification'
  ) {
    const tn = message as {
      task_id: string;
      status: string;
      summary: string;
    };
    log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
  }

  if (message.type === 'result') {
    resultCount++;
    const textResult =
      'result' in message ? (message as { result?: string }).result : null;
    writeOutput({
      status: 'success',
      result: textResult || null,
      newSessionId,
    });
  }
}
```

**Currently handled messages:**
- `system/init` - Session initialization
- `assistant` - Claude responses
- `system/task_notification` - Task status updates
- `result` - Final results (success or error)

**Not yet surfaced (opportunity for enhancement):**
- Tool invocation events (`tool_progress`, `tool_use_summary`)
- Rate limit changes (`rate_limit_event`)
- File persistence events (`files_persisted`)
- Hook lifecycle messages
- Session state changes (`session_state_changed`)
- API retry attempts (`api_retry`)
- Compact boundaries (`compact_boundary`)
- Auth status (`auth_status`)

---

## Common Patterns

### Pattern 1: Detecting Tool Execution
Monitor `tool_progress` messages to detect intermediate actions:
```typescript
if (message.type === 'tool_progress') {
  console.log(`Tool ${message.tool_name} executing (${message.elapsed_time_seconds}s)`);
}
```

### Pattern 2: Detecting Task Background Jobs
```typescript
if (message.type === 'system' && message.subtype === 'task_started') {
  console.log(`Background task started: ${message.description}`);
}
if (message.type === 'system' && message.subtype === 'task_notification') {
  console.log(`Task ${message.task_id} ${message.status}`);
}
```

### Pattern 3: Detecting Rate Limiting
```typescript
if (message.type === 'rate_limit_event') {
  if (message.rate_limit_info.status === 'rejected') {
    console.log('Rate limited!');
  }
}
```

### Pattern 4: Detecting Context Compaction
```typescript
if (message.type === 'system' && message.subtype === 'compact_boundary') {
  console.log(`Context compacted: ${message.compact_metadata.pre_tokens} → reduced`);
}
```

---

## Type Distribution Summary

| Category | Count | Key Types |
|----------|-------|-----------|
| Core Messages | 3 | Assistant, User, Result |
| System Events | 8 | Init, Status, API Retry, Compact Boundary, Session State, Auth, Local Output |
| Tool Events | 2 | Tool Progress, Tool Use Summary |
| Task Events | 3 | Task Started, Task Progress, Task Notification |
| Hook Events | 3 | Hook Started, Hook Progress, Hook Response |
| File/Persist | 1 | Files Persisted |
| Rate/Elicit | 2 | Rate Limit Event, Elicitation Complete |
| Utility | 1 | Prompt Suggestion |
| **Total** | **23** | |

---

## Reference Sections

### Permission Denial Tracking
```typescript
type SDKPermissionDenial = {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
};
```
Included in `SDKResultMessage` as `permission_denials[]`

### Deferred Tool Use
```typescript
type SDKDeferredToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};
```
Incomplete tool use returned in `SDKResultSuccess.deferred_tool_use`

### Session Info
```typescript
type SDKSessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
};
```

---

