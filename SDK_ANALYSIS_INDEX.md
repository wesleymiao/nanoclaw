# Claude Agent SDK Message Types - Analysis Index

**Analysis Date:** April 18, 2026  
**SDK Version:** @anthropic-ai/claude-agent-sdk@0.2.92  
**Project:** NanoClaw (/home/azureuser/nanoclaw)

---

## 📋 Documentation Files

This analysis has generated **4 comprehensive documents** for exploring the Claude Agent SDK:

### 1. **SDK_MESSAGE_TYPES_SUMMARY.txt** ⭐ START HERE
**Quick Overview** (8.6 KB)  
Best for: Getting the executive summary, quick facts, recommendations
- Executive summary of all 23 message types
- Current vs. potential coverage in NanoClaw
- Short implementation guide with code examples
- Recommendations for enhancement

**Read this if:** You want the TL;DR version with actionable insights

---

### 2. **CLAUDE_AGENT_SDK_QUICK_REFERENCE.md**
**One-Page Cheat Sheet** (4.9 KB)  
Best for: Quick lookups, frequency of messages, detection patterns
- All 23 message types in categorized list
- Message frequency (high/medium/low)
- How to detect different actions
- Currently used vs. missing messages
- Key supported tools

**Read this if:** You need a quick reference while coding

---

### 3. **CLAUDE_AGENT_SDK_MESSAGE_TYPES.md** ⭐ COMPREHENSIVE
**Complete Technical Reference** (21 KB)  
Best for: Deep dive, understanding structures, type definitions
- Full TypeScript type definitions for every message
- Complete interface definitions
- Example structures with all fields
- Pattern detection code examples
- Reference sections for permissions, deferred tool use, session info
- Type distribution summary

**Read this if:** You need to understand the complete structure

---

### 4. **INTERMEDIATE_ACTIONS_GUIDE.md**
**How to Observe Agent Actions** (10 KB)  
Best for: Building features that show what the agent is doing
- What are intermediate actions?
- 9 detection points with code examples
- Complete example flow (user asks → tool invocations → result)
- Integration opportunities for NanoClaw
- Code example: Extract all actions
- Critical message types for actions

**Read this if:** You're building real-time action visibility features

---

## 🎯 Quick Start Guide

### I want to...

**...understand what messages exist**  
→ Read: `SDK_MESSAGE_TYPES_SUMMARY.txt` (5 min)

**...see complete type definitions**  
→ Read: `CLAUDE_AGENT_SDK_MESSAGE_TYPES.md` (15 min)

**...add intermediate action tracking**  
→ Read: `INTERMEDIATE_ACTIONS_GUIDE.md` (10 min)

**...look up a specific message type**  
→ Use: `CLAUDE_AGENT_SDK_QUICK_REFERENCE.md` (2 min)

**...implement tool progress tracking**  
→ Code examples in: `INTERMEDIATE_ACTIONS_GUIDE.md` (implementation section)

**...understand NanoClaw's current usage**  
→ All files reference: `/container/agent-runner/src/index.ts`

---

## 📊 Message Types at a Glance

### Total: 23 Message Types

| Category | Count | Examples |
|----------|-------|----------|
| Core (User/Assistant) | 3 | Assistant, User, UserReplay |
| Streaming | 1 | PartialAssistant |
| Results | 2 | ResultSuccess, ResultError |
| **Tools** ⭐ | 2 | ToolProgress, ToolUseSummary |
| **System Events** | 8 | Init, Status, APIRetry, Compact, SessionState, Auth, LocalOutput, FilesPersisted |
| **Background Tasks** | 3 | TaskStarted, TaskProgress, TaskNotification |
| Hooks | 3 | HookStarted, HookProgress, HookResponse |
| Utility | 2 | RateLimit, ElicitationComplete, PromptSuggestion |

⭐ **Most important for intermediate actions:** Tool-related and Task-related messages

---

## 🔧 Current NanoClaw Coverage

### Captured (4 message types)
```
✓ system/init          - Session initialization
✓ assistant            - Claude responses (with hidden tool invocations)
✓ system/task_notification - Task completion/failure
✓ result               - Final result (success or error)
```

### NOT Captured (19 message types - Opportunity!)
```
✗ tool_progress        - Would show "Running Bash 5s..."
✗ tool_use_summary     - Would show "Executed 3 commands"
✗ stream_event         - Streaming chunks
✗ system/status        - Compaction status
✗ system/api_retry     - API failures
✗ system/compact_boundary - Context limits
✗ system/session_state_changed - idle/running/requires_action
✗ system/auth_status   - Auth events
✗ system/local_command_output - Command output
✗ system/files_persisted - File operations
✗ system/hook_*        - Hook lifecycle (3 types)
✗ system/task_progress - Live task updates
✗ rate_limit_event     - Rate limiting
✗ elicitation_complete - MCP completions
✗ prompt_suggestion    - Suggested next prompts
```

---

## 🚀 Recommended Quick Wins

### For Better Intermediate Action Visibility

#### Priority 1 (Easy, High Impact)
1. **Add Tool Progress Tracking**
   - Capture: `message.type === 'tool_progress'`
   - Display: "🔧 Running: {tool_name} ({elapsed_time}s)"
   - Code: See `INTERMEDIATE_ACTIONS_GUIDE.md`

2. **Add Session State Changes**
   - Capture: `message.type === 'system' && subtype === 'session_state_changed'`
   - Display: "🔄 Processing..." or "⏸️ Idle"
   - Helps with UI responsiveness

#### Priority 2 (Medium, Valuable)
3. **Add Task Progress Tracking**
   - Capture: `message.type === 'system' && subtype === 'task_progress'`
   - Display: Live updates with token count and tool count
   - Better UX for long-running tasks

4. **Add Tool Use Summary**
   - Capture: `message.type === 'tool_use_summary'`
   - Display: "✅ {summary}" - high-level overview of what was done

#### Priority 3 (Advanced)
5. **Add API Retry Tracking**
   - Show when API fails with reason
   - Help debug issues

6. **Add Rate Limit Events**
   - Warn users when rate limited
   - Transparency on throttling

---

## 📐 Message Flow Example

```
User asks: "Find TypeScript files and count lines"
↓
→ USER MESSAGE (type: 'user')
  "Find all TypeScript files..."
↓
→ ASSISTANT MESSAGE (type: 'assistant')
  Content: [
    { type: 'text', text: 'I'll find files...' },
    { type: 'tool_use', id: 'call_1', name: 'Bash', 
      input: { command: 'find . -name "*.ts"' } }
  ]
↓
→ TOOL PROGRESS (type: 'tool_progress') [every few seconds]
  { tool_name: 'Bash', elapsed_time_seconds: 0.5 }
  { tool_name: 'Bash', elapsed_time_seconds: 1.2 }
↓
→ ASSISTANT MESSAGE (type: 'assistant')
  Content: [
    { type: 'text', text: 'Found 42 files...' },
    { type: 'tool_use', id: 'call_2', name: 'Bash',
      input: { command: 'wc -l **/*.ts | tail -1' } }
  ]
↓
→ TOOL PROGRESS (type: 'tool_progress')
  { tool_name: 'Bash', elapsed_time_seconds: 0.3 }
↓
→ TOOL SUMMARY (type: 'tool_use_summary')
  "Executed 2 bash commands to find and count files"
↓
→ RESULT (type: 'result', subtype: 'success')
  "12,543 lines across 42 files"
```

**Observable Actions:**
- Tool invocations (in assistant messages)
- Tool execution progress (in tool_progress messages)
- What was accomplished (in tool_use_summary)
- Final result (in result message)

---

## 🔍 How to Find Information

### By Message Type
- **SDKAssistantMessage** → See: `CLAUDE_AGENT_SDK_MESSAGE_TYPES.md` page for "Assistant Messages"
- **SDKToolProgressMessage** → See: `INTERMEDIATE_ACTIONS_GUIDE.md` section "Tool Progress Tracking"
- **SDKTaskStartedMessage** → See: `INTERMEDIATE_ACTIONS_GUIDE.md` section "Background Tasks"

### By Concept
- **"How do I see what tools the agent is using?"** → `INTERMEDIATE_ACTIONS_GUIDE.md`
- **"What fields does SDKResultSuccess have?"** → `CLAUDE_AGENT_SDK_MESSAGE_TYPES.md`
- **"Which messages should I capture?"** → `SDK_MESSAGE_TYPES_SUMMARY.txt`
- **"How often does X message appear?"** → `CLAUDE_AGENT_SDK_QUICK_REFERENCE.md`

### By Implementation Task
- **"Show tool execution progress in WhatsApp"** → `INTERMEDIATE_ACTIONS_GUIDE.md` + code examples
- **"Track all intermediate actions"** → `INTERMEDIATE_ACTIONS_GUIDE.md` + code example section
- **"Add task progress updates"** → `SDK_MESSAGE_TYPES_SUMMARY.txt` + implementation guide
- **"Detect rate limiting"** → `INTERMEDIATE_ACTIONS_GUIDE.md` + `CLAUDE_AGENT_SDK_MESSAGE_TYPES.md`

---

## 📌 Key Insights

### About the SDK
- **23 message types** total
- **Async iterable interface** - messages stream in real-time
- **UUID tracking** - every message has unique ID
- **Session awareness** - all messages know their session
- **Hierarchical tool tracking** - supports nested tool calls

### About Intermediate Actions
- **Tool invocations** are in `SDKAssistantMessage.message.content[]`
- **Tool progress** streams via `SDKToolProgressMessage` every few seconds
- **Task background jobs** have start → progress → completion pattern
- **All actions traceable** via unique IDs and parent-child relationships

### About NanoClaw Integration
- **Current bottleneck:** Only 4 of 23 messages being surfaced
- **Quick wins:** Add tool progress + session state + task progress
- **User value:** Show "what is the agent doing right now?" capability
- **Technical lift:** Simple if/else statements on message.type

---

## 🎓 Terminology

- **Message Type** - The `type` field (e.g., 'assistant', 'tool_progress', 'result')
- **Subtype** - The `subtype` field for system messages (e.g., 'init', 'task_started')
- **Tool Use** - When agent decides to invoke a tool (e.g., Bash, Read)
- **Tool Invocation** - When the tool actually starts running
- **Tool Progress** - Periodic updates during tool execution
- **Intermediate Action** - Any observable step the agent takes (tool use, task start, etc.)
- **Content Block** - Part of a message.content array (text or tool_use)

---

## ✅ Verification

This analysis was generated by:
1. Installing `@anthropic-ai/claude-agent-sdk@0.2.92` from npm
2. Extracting type definitions from `sdk.d.ts`
3. Analyzing `/container/agent-runner/src/index.ts` usage
4. Cross-referencing with package.json and documentation

**All type information is accurate** as of version 0.2.92.

---

## 🔗 Related Files

- **Agent Runner Code:** `/container/agent-runner/src/index.ts`
- **Package Definition:** `/container/agent-runner/package.json`
- **SDK Source:** `@anthropic-ai/claude-agent-sdk` (npm package)

---

## 📞 Next Steps

1. **Read:** `SDK_MESSAGE_TYPES_SUMMARY.txt` (5 min)
2. **Explore:** `INTERMEDIATE_ACTIONS_GUIDE.md` (10 min)
3. **Implement:** Add one of the "Priority 1" features above
4. **Reference:** Use `CLAUDE_AGENT_SDK_QUICK_REFERENCE.md` while coding
5. **Deep Dive:** Check `CLAUDE_AGENT_SDK_MESSAGE_TYPES.md` for specific fields

---

**Questions?** All information is contained in these 4 documents.  
**Found a gap?** The complete type definitions are in `CLAUDE_AGENT_SDK_MESSAGE_TYPES.md`.
