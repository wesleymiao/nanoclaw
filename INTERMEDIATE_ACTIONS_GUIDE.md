# Intermediate Actions in Claude Agent SDK Messages

## What Are Intermediate Actions?

Intermediate actions are the **step-by-step operations** the agent takes while executing a query. Rather than just seeing the final result, you can observe:

- 🔧 Every tool invocation (Bash, Read, Write, etc.)
- ⏱️ How long each tool takes
- 📊 Real-time progress indicators
- 🎯 Nested/dependent tool calls
- ✅ Success or failure of each step
- 📈 Token usage per step
- 🚀 Background task execution
- 🔄 State transitions

---

## Detection Points in SDK Messages

### 1. Tool Invocations (Most Important)

#### Where: `SDKAssistantMessage.message.content`
```typescript
if (message.type === 'assistant') {
  message.message.content.forEach(block => {
    if (block.type === 'tool_use') {
      console.log(`⚡ Tool invoked: ${block.name}`);
      console.log(`   ID: ${block.id}`);
      console.log(`   Input: ${JSON.stringify(block.input)}`);
    }
  });
}
```

#### Available Tools
| Category | Tools |
|----------|-------|
| **File I/O** | Read, Write, Edit, Glob |
| **Search** | Grep, WebSearch, WebFetch |
| **Execution** | Bash |
| **Task Mgmt** | Task, TaskOutput, TaskStop, TeamCreate, TeamDelete |
| **Utilities** | Skill, SendMessage, TodoWrite, NotebookEdit |
| **MCP** | mcp__nanoclaw__* (custom) |

#### Example Flow
```
1. Assistant generates:
   - tool_use: Bash { command: "find . -name '*.ts'" }
   
2. SDK emits:
   - tool_progress: elapsed_time_seconds=0.1
   - tool_progress: elapsed_time_seconds=0.5
   - tool_progress: elapsed_time_seconds=1.2
   
3. Assistant gets result and generates:
   - tool_use: Read { path: "src/index.ts" }
   
4. SDK emits:
   - tool_progress: elapsed_time_seconds=0.05
   
5. Eventually:
   - result: { type: 'result', result: "..." }
```

---

### 2. Tool Progress Tracking

#### Where: `SDKToolProgressMessage` (emitted every few seconds)
```typescript
if (message.type === 'tool_progress') {
  console.log(`⏱️  Tool: ${message.tool_name}`);
  console.log(`   Elapsed: ${message.elapsed_time_seconds}s`);
  console.log(`   Tool ID: ${message.tool_use_id}`);
  if (message.parent_tool_use_id) {
    console.log(`   Parent: ${message.parent_tool_use_id}`);
  }
}
```

#### What You Get
- Tool execution duration
- Nested tool detection (parent_tool_use_id)
- Real-time progress without waiting for result

---

### 3. Tool Summaries

#### Where: `SDKToolUseSummaryMessage`
```typescript
if (message.type === 'tool_use_summary') {
  console.log(`📊 Summary: ${message.summary}`);
  console.log(`   Tools: ${message.preceding_tool_use_ids.join(', ')}`);
}
```

#### Purpose
High-level natural language summary of multiple tool executions that just completed.

---

### 4. Background Tasks

#### Where: Multiple System Messages
```typescript
// Task starts
if (message.type === 'system' && message.subtype === 'task_started') {
  console.log(`🚀 Task started: ${message.description}`);
  console.log(`   ID: ${message.task_id}`);
  console.log(`   Type: ${message.task_type || 'unknown'}`);
}

// Task progress
if (message.type === 'system' && message.subtype === 'task_progress') {
  console.log(`📈 Task progress: ${message.description}`);
  console.log(`   Tokens: ${message.usage.total_tokens}`);
  console.log(`   Tool uses: ${message.usage.tool_uses}`);
  console.log(`   Last tool: ${message.last_tool_name}`);
}

// Task completes
if (message.type === 'system' && message.subtype === 'task_notification') {
  console.log(`✅ Task ${message.status}: ${message.summary}`);
  console.log(`   Output file: ${message.output_file}`);
}
```

#### Task States
- `task_started` → `task_progress`* → `task_notification`

---

### 5. Session State Changes

#### Where: `SDKSessionStateChangedMessage`
```typescript
if (message.type === 'system' && message.subtype === 'session_state_changed') {
  switch (message.state) {
    case 'idle':
      console.log('⏸️  Session now idle (ready for next input)');
      break;
    case 'running':
      console.log('🔄 Session running (agent processing)');
      break;
    case 'requires_action':
      console.log('⚠️  Session requires action (waiting for input)');
      break;
  }
}
```

#### State Flow
- `idle` → `running` → `idle` (or `requires_action`)

---

### 6. API Errors & Retries

#### Where: `SDKAPIRetryMessage`
```typescript
if (message.type === 'system' && message.subtype === 'api_retry') {
  console.log(`🔁 API Retry: ${message.attempt}/${message.max_retries}`);
  console.log(`   Error: ${message.error} (HTTP ${message.error_status})`);
  console.log(`   Waiting: ${message.retry_delay_ms}ms`);
}
```

#### Error Types
- `authentication_failed`
- `billing_error`
- `rate_limit`
- `invalid_request`
- `server_error`
- `unknown`
- `max_output_tokens`

---

### 7. Context Compaction

#### Where: `SDKCompactBoundaryMessage`
```typescript
if (message.type === 'system' && message.subtype === 'compact_boundary') {
  console.log(`💾 Context compaction:`);
  console.log(`   Trigger: ${message.compact_metadata.trigger} (manual/auto)`);
  console.log(`   Pre-compression: ${message.compact_metadata.pre_tokens} tokens`);
}
```

#### Meaning
Agent's context window is being automatically or manually compressed. This happens during long conversations.

---

### 8. File Operations

#### Where: `SDKFilesPersistedEvent`
```typescript
if (message.type === 'system' && message.subtype === 'files_persisted') {
  console.log(`💾 Files persisted:`);
  message.files.forEach(f => {
    console.log(`   ✓ ${f.filename}`);
  });
  message.failed.forEach(f => {
    console.log(`   ✗ ${f.filename}: ${f.error}`);
  });
}
```

---

### 9. Rate Limiting

#### Where: `SDKRateLimitEvent`
```typescript
if (message.type === 'rate_limit_event') {
  const info = message.rate_limit_info;
  console.log(`⛔ Rate limit status: ${info.status}`);
  if (info.status === 'allowed_warning') {
    console.log(`   Resets at: ${new Date(info.resetsAt)}`);
    console.log(`   Type: ${info.rateLimitType}`);
  }
}
```

---

## Complete Example Flow

### User Asks: "Find all .ts files and count lines of code"

```
→ USER MESSAGE
  type: 'user'
  message: { role: 'user', content: 'Find all .ts files...' }

→ ASSISTANT RESPONSE (with tool invocation)
  type: 'assistant'
  message.content: [
    { type: 'text', text: 'I'll find all TypeScript files...' },
    { type: 'tool_use', id: 'call_1', name: 'Bash', 
      input: { command: 'find . -name "*.ts" -type f' } }
  ]

→ TOOL PROGRESS (while Bash executes)
  type: 'tool_progress'
  tool_name: 'Bash'
  tool_use_id: 'call_1'
  elapsed_time_seconds: 0.3

→ ASSISTANT RESPONSE (processes Bash output)
  type: 'assistant'
  message.content: [
    { type: 'text', text: 'Found 42 files. Now counting...' },
    { type: 'tool_use', id: 'call_2', name: 'Bash',
      input: { command: 'wc -l **/*.ts | tail -1' } }
  ]

→ TOOL PROGRESS (while Bash executes)
  type: 'tool_progress'
  tool_name: 'Bash'
  tool_use_id: 'call_2'
  elapsed_time_seconds: 0.5

→ TOOL SUMMARY
  type: 'tool_use_summary'
  summary: 'Executed 2 bash commands to find and count files'
  preceding_tool_use_ids: ['call_1', 'call_2']

→ RESULT
  type: 'result'
  subtype: 'success'
  result: '12,543 lines of code across 42 files'
  duration_ms: 2100
  num_turns: 2
```

---

## Integration Points for NanoClaw

### Currently Missing
The agent-runner only surfaces:
- ✅ Assistant messages
- ✅ System init
- ✅ Task notifications
- ✅ Result

### Should Add
- 🔧 **Tool progress** → Show "Agent is running Bash command..."
- 📊 **Tool summaries** → Show what tools were executed
- ⏸️ **Session state changes** → Better UI feedback
- 🔁 **API retries** → Transparency on failures
- 📈 **Task progress** → Live updates on background tasks
- 💾 **File persistence** → Confirm file operations
- ⛔ **Rate limits** → Alert users if rate limited

### In WhatsApp/Telegram
These intermediate messages could be surfaced as:
```
🤖 Agent working...
⏳ Running: Bash (15s elapsed)
📊 Found 42 matching files
🔄 Processing: Read (3s)
```

---

## Code Example: Extract All Intermediate Actions

```typescript
const actions = [];

for await (const message of query({...})) {
  // Capture tool invocations
  if (message.type === 'assistant') {
    message.message.content?.forEach(block => {
      if (block.type === 'tool_use') {
        actions.push({
          type: 'tool_invocation',
          tool: block.name,
          id: block.id,
          input: block.input,
          timestamp: new Date(),
        });
      }
    });
  }
  
  // Capture tool progress
  if (message.type === 'tool_progress') {
    actions.push({
      type: 'tool_progress',
      tool: message.tool_name,
      id: message.tool_use_id,
      elapsed: message.elapsed_time_seconds,
    });
  }
  
  // Capture task transitions
  if (message.type === 'system') {
    if (message.subtype === 'task_started') {
      actions.push({
        type: 'task_started',
        taskId: message.task_id,
        description: message.description,
      });
    } else if (message.subtype === 'task_notification') {
      actions.push({
        type: 'task_completed',
        taskId: message.task_id,
        status: message.status,
        summary: message.summary,
      });
    }
  }
  
  // Capture state changes
  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    actions.push({
      type: 'state_changed',
      state: message.state,
    });
  }
}

console.log(JSON.stringify(actions, null, 2));
```

---

## Summary

The SDK emits **23 message types**, of which **7 are critical** for tracking intermediate actions:

1. **SDKAssistantMessage** - Tool invocations
2. **SDKToolProgressMessage** - Tool execution progress
3. **SDKToolUseSummaryMessage** - What was done
4. **SDKTaskStartedMessage** - Background job started
5. **SDKTaskProgressMessage** - Background job progress  
6. **SDKTaskNotificationMessage** - Background job done
7. **SDKSessionStateChangedMessage** - Workflow state

These can paint a detailed picture of what the agent is doing moment-by-moment.

