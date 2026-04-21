# NanoClaw Channel System: Quick Start Guide

## TL;DR - How Channels Work

```
1. REGISTRATION (at startup)
   ├─ src/channels/index.ts imports './slack.js', './feishu.js'
   ├─ Each module calls registerChannel('name', factory)
   └─ Factory stored in Map if credentials exist in .env

2. INITIALIZATION (on demand)
   ├─ Core calls getChannelFactory('slack')
   ├─ Invokes factory with (onMessage, onChatMetadata, registeredGroups)
   └─ Channel instance connects via WebSocket/HTTP

3. MESSAGE INBOUND
   ├─ Platform event arrives → Channel handler receives it
   ├─ Handler parses event → creates NewMessage object
   ├─ Translates @mentions to @ASSISTANT_NAME
   └─ Calls opts.onMessage(jid, message) → Core routes to agent

4. MESSAGE OUTBOUND
   ├─ Core calls channel.sendMessage(jid, text)
   ├─ Channel extracts file references (markdown ![alt](path))
   ├─ Uploads files to platform
   ├─ Sends text (chunks if needed)
   └─ Queues on failure, retries on reconnect
```

## The Core Channel Interface

```typescript
interface Channel {
  // Required
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  
  // Optional (implement if platform supports)
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  reactToMessage?(jid: string, messageId: string, emoji: string): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

## Message Type

```typescript
// What channels deliver to core
interface NewMessage {
  id: string;              // Platform message ID
  chat_jid: string;        // "slack:C123" format
  sender: string;          // Platform user ID
  sender_name: string;     // Human name (must be resolved by channel!)
  content: string;         // Text (mentions already translated)
  timestamp: string;       // ISO 8601
  is_from_me: boolean;     // Bot's own message?
}
```

## JID Format

Each platform owns a prefix:
- `slack:C0123456789` ← Slack channel ID
- `feishu:oc_xxx` ← Feishu chat ID
- `whatsapp:1234567890` ← WhatsApp phone
- `telegram:123456789` ← Telegram chat ID

## Self-Registration Pattern

```typescript
// At the END of src/channels/slack.ts
registerChannel('slack', (opts: ChannelOpts) => {
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN) {
    return null;  // ← Gracefully disabled if creds missing
  }
  return new SlackChannel(opts);
});
```

Then add to `src/channels/index.ts`:
```typescript
import './slack.js';  // ← Triggers registerChannel() on module load
```

## Message Flow Diagram

```
┌─────────────────────┐
│ User sends message  │
│ on Slack/Feishu     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────────────┐
│ Channel.setupEventHandlers()    │
│ receives platform event         │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│ Parse event:                    │
│ - Extract jid, sender, content  │
│ - Resolve sender name           │
│ - Translate @mentions           │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│ Call opts.onMessage(jid, msg)   │
│ (deliver to core)               │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│ Core checks:                    │
│ - Is jid registered?            │
│ - Does content match trigger?   │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│ Core passes to agent            │
│ Agent generates response        │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│ Core calls:                     │
│ channel.sendMessage(jid, text)  │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│ Channel:                        │
│ 1. Extract file refs            │
│ 2. Upload files                 │
│ 3. Send text (chunk if needed)  │
│ 4. Queue on error               │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│ Message appears in chat         │
└─────────────────────────────────┘
```

## Key Patterns

### 1. Message Queuing (Slack & Feishu)
```typescript
private outgoingQueue: Array<{ jid: string; text: string }> = [];

async sendMessage(jid: string, text: string): Promise<void> {
  if (!this.connected) {
    this.outgoingQueue.push({ jid, text });  // Queue it
    return;
  }
  // ... send via API
}

async connect(): Promise<void> {
  await this.wsClient.start(...);
  this.connected = true;
  await this.flushOutgoingQueue();  // Send all queued
}
```

### 2. Mention Translation
```typescript
// Slack: <@BOTID> → @ASSISTANT_NAME
const mentionPattern = `<@${this.botUserId}>`;
if (content.includes(mentionPattern)) {
  content = `@${ASSISTANT_NAME} ${content}`;
}

// Feishu: <at user_id="...">name</at> → @ASSISTANT_NAME
const atPattern = /<at user_id="[^"]*">[^<]*<\/at>/g;
if (atPattern.test(content)) {
  content = `@${ASSISTANT_NAME} ${content.replace(atPattern, '').trim()}`;
}
```

### 3. File Reference Extraction
```typescript
private extractFileReferences(jid: string, text: string) {
  const filePaths: string[] = [];
  const imgPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  
  let cleanText = text.replace(imgPattern, (_, path: string) => {
    const hostPath = this.resolveContainerPath(jid, path);
    if (hostPath) {
      filePaths.push(hostPath);
      return '';  // Remove markdown
    }
    return _;
  });
  
  return { cleanText, filePaths };
}
```

### 4. Bot Message Detection (avoid loops)
```typescript
// Only process non-bot messages
const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;
if (isBotMessage) {
  // Don't echo bot's own message
  return;
}
```

### 5. Optional Capabilities
```typescript
// Core safely checks before calling
if (channel.setTyping) {
  await channel.setTyping(jid, true);
}

if (channel.reactToMessage) {
  await channel.reactToMessage(jid, msgId, '👍');
}

// No crash if method missing
```

## Slack vs Feishu: Key Differences

| Feature | Slack | Feishu |
|---------|-------|--------|
| Connection | Socket Mode (WS) | WebSocket via SDK |
| Registration | Manual pre-register | Auto on first message |
| Credentials | BOT_TOKEN, APP_TOKEN | APP_ID, APP_SECRET |
| Message Format | Plain text | JSON: `{text: "..."}` |
| Typing Indicator | No (faked) | No |
| Reactions | No | Yes ✓ |
| File Upload | Single API | Separate image/file APIs |
| Deduplication | Not needed | Yes (3s re-push) |
| Threads | Flattened | Basic support |

## Adding a New Channel: Checklist

### Code Side
- [ ] Create `src/channels/myplatform.ts`
- [ ] Implement `Channel` interface (5 required methods)
- [ ] Read credentials via `readEnvFile(['MYPLATFORM_...'])`
- [ ] In event handler: parse → NewMessage, resolve names, translate mentions
- [ ] Call `opts.onMessage(jid, message)` for registered groups only
- [ ] Implement message queuing + flush on connect
- [ ] Call `registerChannel('myplatform', factory)` at end
- [ ] Add `import './myplatform.js'` to `src/channels/index.ts`

### Skill Side
- [ ] Create `.claude/skills/add-myplatform/SKILL.md`
- [ ] Phase 1: Check if creds exist, ask user
- [ ] Phase 2: Merge skill branch (with implementation)
- [ ] Phase 3: Walk user through creating bot/app
- [ ] Phase 4: Register channels in NanoClaw
- [ ] Phase 5: Verify bot responds

## Testing

```bash
# Build + test
npm run build
npx vitest run src/channels/myplatform.test.ts

# Check logs
tail -f logs/nanoclaw.log | grep myplatform

# Manual: send message in platform, bot should reply
```

## Common Gotchas

1. **Forgot to translate mentions?** Platform mentions won't match TRIGGER_PATTERN
2. **Forgot to distinguish bot messages?** Bot will echo itself in a loop
3. **Forgot to resolve sender names?** Core gets empty strings instead of display names
4. **Forgot message queuing?** Messages sent before connect() are lost
5. **Forgot to check registeredGroups()?** All messages (including unregistered) trigger agent
6. **Used `process.env` instead of `readEnvFile()`?** Secrets leak to child processes

## File Structure

```
src/channels/
  ├─ registry.ts      ← Factory pattern, Map of channels
  ├─ index.ts         ← Barrel file, imports all channels
  ├─ slack.ts         ← SlackChannel implementation (410 lines)
  ├─ feishu.ts        ← FeishuChannel implementation (526 lines)
  └─ slack.test.ts    ← Tests for Slack channel

.claude/skills/
  └─ add-slack/
      └─ SKILL.md     ← Interactive setup guide (208 lines)
```

## Limitations

- **Slack threads** are flattened (no thread awareness in responses)
- **Typing indicators** not exposed by some platforms (Slack)
- **Message chunking** is naive (breaks mid-word on long messages)
- **File handling** requires markdown format (implicit contract)
- **Metadata sync** unbounded (no timeout for large workspaces)

## Further Reading

- `nanoclaw_channel_system.md` — Comprehensive deep dive (30KB)
- `channel_architecture_summary.md` — Quick reference with diagrams (12KB)
- Source: `src/channels/slack.ts`, `src/channels/feishu.ts`
- Skill: `.claude/skills/add-slack/SKILL.md`
- Contributing: `CONTRIBUTING.md` (skill guidelines)
