# Claude Agent SDK - Quick Reference Summary

## 23 Total Message Types

### Master Union Type: `SDKMessage`

All messages from `query()` are one of these 23 types.

---

## Message Types by Category

### Core (3)
1. **SDKAssistantMessage** - Claude's response with `content` blocks (text, tool_use)
2. **SDKUserMessage** - User input or synthetic system messages
3. **SDKUserMessageReplay** - Historical messages when resuming sessions

### Streaming (1)
4. **SDKPartialAssistantMessage** - Streaming chunks (deltas, usage updates)

### Results (2)
5. **SDKResultSuccess** - Successful query completion with metrics
6. **SDKResultError** - Failed query with error details

### Tools (2)
7. **SDKToolProgressMessage** - Periodic updates during tool execution
8. **SDKToolUseSummaryMessage** - High-level summary of completed tools

### System Events (8)
9. **SDKSystemMessage** - Session initialization (first message)
10. **SDKStatusMessage** - Status updates (e.g., "compacting")
11. **SDKAPIRetryMessage** - API error and retry information
12. **SDKCompactBoundaryMessage** - Context compaction markers
13. **SDKSessionStateChangedMessage** - State transitions (idle/running/requires_action)
14. **SDKAuthStatusMessage** - Authentication events
15. **SDKLocalCommandOutputMessage** - Local command output (e.g., /voice)
16. **SDKFilesPersistedEvent** - File operation completion

### Tasks (3)
17. **SDKTaskStartedMessage** - Background task begins
18. **SDKTaskProgressMessage** - Periodic task progress updates
19. **SDKTaskNotificationMessage** - Task completion/failure/stop

### Hooks (3)
20. **SDKHookStartedMessage** - Hook execution begins
21. **SDKHookProgressMessage** - Periodic hook output
22. **SDKHookResponseMessage** - Hook completion with result

### Utility (2)
23. **SDKRateLimitEvent** - Rate limit status changes
24. **SDKElicitationCompleteMessage** - MCP elicitation completion
25. **SDKPromptSuggestionMessage** - AI-predicted next prompt

---

## Message Frequency

### High-Frequency (Every query)
- `assistant` - Each Claude turn
- `stream_event` - Streaming chunks
- `tool_progress` - During tool execution
- `user` - Input messages
- `result` - Query completion

### Medium-Frequency (Occasionally)
- `system/init` - Session start
- `system/status` - Compaction events
- `system/task_*` - Background tasks
- `tool_use_summary` - Tool summaries

### Low-Frequency (Rare)
- `system/api_retry` - API errors only
- `system/hook_*` - Hook execution
- `system/compact_boundary` - Compaction only
- `auth_status` - Auth events
- `rate_limit_event` - Rate limit changes
- `files_persisted` - File operations

---

## How to Detect What's Happening

### Tool Execution
```typescript
if (message.type === 'tool_progress') {
  // Tool named message.tool_name is running
  // Elapsed: message.elapsed_time_seconds
}
```

### Background Tasks
```typescript
if (message.type === 'system' && message.subtype === 'task_started') {
  // Task message.task_id started: message.description
}
if (message.type === 'system' && message.subtype === 'task_notification') {
  // Task message.task_id: message.status (completed/failed/stopped)
}
```

### Rate Limits
```typescript
if (message.type === 'rate_limit_event') {
  // Check message.rate_limit_info.status
}
```

### Context Compaction
```typescript
if (message.type === 'system' && message.subtype === 'compact_boundary') {
  // Compaction triggered by message.compact_metadata.trigger
}
```

### Session State
```typescript
if (message.type === 'system' && message.subtype === 'session_state_changed') {
  // State is: message.state (idle/running/requires_action)
}
```

---

## Currently Used in NanoClaw

From `container/agent-runner/src/index.ts`:

✓ `system/init` - Captured  
✓ `assistant` - Captured  
✓ `system/task_notification` - Captured  
✓ `result` - Captured  

❌ `tool_progress` - NOT captured (opportunity!)  
❌ `rate_limit_event` - NOT captured  
❌ `system/session_state_changed` - NOT captured  
❌ Hook messages - NOT captured  
❌ Compaction events - NOT captured  

---

## Key Structures

### Tool Invocations (In SDKAssistantMessage)
```typescript
message.message.content[] {
  type: 'text' | 'tool_use'
  // if tool_use:
  id: string
  name: string (Bash, Read, Write, Grep, etc.)
  input: { [key: string]: unknown }
}
```

### Supported Tools
- **File**: Read, Write, Edit, Glob
- **Search**: Grep, WebSearch, WebFetch
- **Exec**: Bash
- **Task**: Task, TaskOutput, TaskStop
- **Team**: TeamCreate, TeamDelete
- **Other**: Skill, SendMessage, TodoWrite, NotebookEdit
- **MCP**: mcp__nanoclaw__*

### Error Results
```typescript
if (message.type === 'result' && message.subtype !== 'success') {
  message.errors[] // String array of error messages
  message.permission_denials[] // Denied tool uses
}
```

---

## Files
- **Full Documentation:** `/home/azureuser/nanoclaw/CLAUDE_AGENT_SDK_MESSAGE_TYPES.md`
- **SDK Version:** 0.2.92
- **SDK Package:** `@anthropic-ai/claude-agent-sdk`
