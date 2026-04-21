# NanoClaw Channel System: Quick Reference

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Core Orchestrator                       │
│  - Registers groups                                         │
│  - Routes messages to groups                                │
│  - Calls channel.sendMessage() for responses                │
└────────────────┬────────────────────────────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
   ChannelRegistry    Channel Instance
   (registry.ts)      (e.g., SlackChannel)
        │                 │
     registry Map         ├─→ connect()
     key: string          ├─→ sendMessage()
     val: Factory         ├─→ isConnected()
                          ├─→ ownsJid()
                          ├─→ disconnect()
                          ├─→ setTyping() [optional]
                          ├─→ reactToMessage() [optional]
                          └─→ syncGroups() [optional]
                          
Channel Loading Flow (src/channels/index.ts):
  import './slack.js'
  import './feishu.js'
        ↓
  Each module ends with:
    registerChannel('slack', (opts) => new SlackChannel(opts))
    registerChannel('feishu', (opts) => new FeishuChannel(opts))
        ↓
  Registry now contains both factories

Credential Check:
  registerChannel('slack', (opts) => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    if (!env.SLACK_BOT_TOKEN) return null;  // Gracefully disabled
    return new SlackChannel(opts);
  });
```

## Message Flow Sequence

```
User sends message on Slack
  ↓
SlackChannel.setupEventHandlers() receives app.event('message')
  ↓
Handler parses event:
  - Extract jid: "slack:C0123456"
  - Resolve sender name (look up in Slack user list)
  - Translate <@BOTID> mentions to "@ASSISTANT_NAME"
  - Determine if message is from bot (avoid loops)
  ↓
Handler calls opts.onMessage(jid, NewMessage):
  {
    id: 'msg_ts',
    chat_jid: 'slack:C0123456',
    sender: 'U123456',
    sender_name: 'Alice',
    content: '@MyBot what time is it?',
    timestamp: '2026-04-19T...',
    is_from_me: false,
    is_bot_message: false
  }
  ↓
Core checks: is jid registered?
  const groups = opts.registeredGroups();
  if (!groups[jid]) return;  // Skip unregistered channels
  ↓
Core checks: does content match TRIGGER_PATTERN?
  For Slack (group): TRIGGER_PATTERN is dynamic regex
  For Feishu (auto-register): trigger might be looser
  ↓
Core passes to agent with context:
  - Group folder path
  - Registered group config
  - Full message history from DB
  ↓
Agent generates response
  ↓
Core calls channel.sendMessage(jid, text):
  "The time is 3:45 PM UTC"
  ↓
SlackChannel.sendMessage():
  1. Extract file references: ![alt](/workspace/group/image.png)
  2. Build list of files to upload
  3. Send text via chat.postMessage() (chunk if >4000 chars)
  4. Upload files via filesUploadV2()
  5. Queue on error + retry on reconnection
  ↓
Message appears in Slack channel
```

## Registry & Factory Pattern

```typescript
// registry.ts
interface ChannelOpts {
  onMessage: OnInboundMessage;        // Callback to deliver messages
  onChatMetadata: OnChatMetadata;     // Callback for group discovery
  registeredGroups: () => Record<string, RegisteredGroup>;  // Live groups
}

type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

// In slack.ts
registerChannel('slack', (opts: ChannelOpts) => {
  // Lazy initialization — only if credentials present
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN) {
    return null;  // Gracefully disabled if creds missing
  }
  return new SlackChannel(opts);
});

// Core usage
const factory = getChannelFactory('slack');
if (factory) {
  const channel = factory(opts);  // Invoke factory
  await channel.connect();
}
```

## JID (Jabber ID) Format

Each channel defines its own JID prefix:

```
slack:C0123456789        ← Slack channel ID
feishu:oc_xxx            ← Feishu chat ID
whatsapp:1234567890      ← WhatsApp phone number
telegram:123456789       ← Telegram chat ID
discord:987654321        ← Discord channel ID
```

JID is used as:
- Database key for storing group registration
- Identifier passed to channel.sendMessage(jid, text)
- Identifier passed to channel.ownsJid(jid) for routing

## Key Interfaces

### Channel (required methods)

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;              // Start listening
  sendMessage(jid, text): Promise<void>; // Send text to channel
  isConnected(): boolean;                // Connection status
  ownsJid(jid): boolean;                 // Does this channel own the JID?
  disconnect(): Promise<void>;           // Clean shutdown
  
  // Optional methods — implement if platform supports
  setTyping?(jid, isTyping): Promise<void>;
  reactToMessage?(jid, msgId, emoji): Promise<void>;
  syncGroups?(force): Promise<void>;
}
```

### NewMessage (what channels deliver to core)

```typescript
interface NewMessage {
  id: string;                      // "msg_ts", "message_id", etc
  chat_jid: string;                // "slack:C123", "feishu:xxx"
  sender: string;                  // Platform user ID
  sender_name: string;             // Human name (must be populated by channel)
  content: string;                 // Text content (mentions already translated)
  timestamp: string;               // ISO 8601
  is_from_me?: boolean;            // Bot's own message
  is_bot_message?: boolean;        // Same (redundant)
  thread_id?: string;              // Optional: parent message
  reply_to_message_id?: string;    // Optional: quoted message
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}
```

### Callbacks (how channels report to core)

```typescript
type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,                 // Chat name (optional)
  channel?: string,              // "slack", "feishu"
  isGroup?: boolean
) => void;
```

## Slack vs Feishu: Comparison

| Aspect | Slack | Feishu |
|--------|-------|--------|
| **Connection** | Socket Mode (WebSocket) | WebSocket via SDK |
| **Registration** | Manual (pre-register) | Auto (first message) |
| **Credentials** | BOT_TOKEN, APP_TOKEN | APP_ID, APP_SECRET |
| **Message Format** | Plain text | JSON: `{text: "..."}` |
| **Typing Indicator** | No native API → fake with "⏳ Working on it..." message | No native API → no-op |
| **Reactions** | Not exposed to bots | ✅ reactToMessage() |
| **File Upload** | Via filesUploadV2() API | Via uploadFile() (image/file separate) |
| **Mention Format** | `<@BOTID>` | `<at user_id="...">name</at>` |
| **Metadata Sync** | Proactive on startup | On-demand per chat |
| **Deduplication** | Not needed (WebSocket) | Yes (3s re-push safety) |
| **Thread Support** | Flattened (limitations noted) | Basic support |

## Common Patterns

### 1. Message Queuing
```typescript
// When connection drops, queue outbound messages
async sendMessage(jid: string, text: string): Promise<void> {
  if (!this.connected) {
    this.outgoingQueue.push({ jid, text });
    return;
  }
  // ... send via API
}

// Flush queue on reconnection
async connect(): Promise<void> {
  await this.wsClient.start(...);
  this.connected = true;
  await this.flushOutgoingQueue();  // Send all queued messages
}
```

### 2. Mention Translation
```typescript
// Slack
const mentionPattern = `<@${this.botUserId}>`;
if (content.includes(mentionPattern) && !TRIGGER_PATTERN.test(content)) {
  content = `@${ASSISTANT_NAME} ${content}`;
}

// Feishu
const atPattern = /<at user_id="[^"]*">[^<]*<\/at>/g;
if (atPattern.test(content) && !TRIGGER_PATTERN.test(content)) {
  content = `@${ASSISTANT_NAME} ${content.replace(atPattern, '').trim()}`;
}
```

### 3. File Reference Extraction
```typescript
// All channels use same pattern
private extractFileReferences(jid: string, text: string) {
  const filePaths: string[] = [];
  const imgPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  
  let cleanText = text.replace(imgPattern, (_, filePath: string) => {
    const hostPath = this.resolveContainerPath(jid, filePath.trim());
    if (hostPath && fs.existsSync(hostPath)) {
      filePaths.push(hostPath);
      return '';  // Remove markdown reference
    }
    return _;
  });
  
  return { cleanText, filePaths };
}
```

### 4. Optional Feature Detection
```typescript
// Core code
if (channel.setTyping) {
  await channel.setTyping(jid, true);
}

if (channel.reactToMessage) {
  await channel.reactToMessage(jid, messageId, '👍');
}

if (channel.syncGroups) {
  await channel.syncGroups(false);
}

// No crashes if methods don't exist
```

### 5. Self-Registration Pattern
```typescript
// At end of channel module
registerChannel('slack', (opts: ChannelOpts) => {
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN) {
    logger.warn('Slack: credentials not set');
    return null;  // Gracefully disabled
  }
  
  try {
    return new SlackChannel(opts);
  } catch (err) {
    logger.error({ err }, 'Failed to create SlackChannel');
    return null;
  }
});
```

## Adding a New Channel

1. **Create `src/channels/myplatform.ts`**
   - Implement `Channel` interface
   - Read credentials via `readEnvFile()`
   - End with `registerChannel('myplatform', factory)`

2. **Add import to `src/channels/index.ts`**
   ```typescript
   import './myplatform.js';
   ```

3. **In constructor:**
   - Initialize SDK client
   - Setup event handlers
   - Map platform events to `NewMessage` type

4. **In connect():**
   - Start listening (WebSocket/webhook/polling)
   - Flush any queued messages
   - Sync metadata if applicable

5. **In event handlers:**
   - Translate platform mentions to `@ASSISTANT_NAME`
   - Distinguish bot messages (avoid loops)
   - Resolve sender names
   - Call `opts.onMessage(jid, message)`

6. **Create `.claude/skills/add-myplatform/SKILL.md`**
   - Phase 1: Pre-flight (check credentials)
   - Phase 2: Merge skill branch (code changes)
   - Phase 3: Setup (user gets tokens)
   - Phase 4: Registration (register channels)
   - Phase 5: Verify (test)

## Testing a Channel

```bash
# Build and run tests
npm run build
npx vitest run src/channels/myplatform.test.ts

# Check logs
tail -f logs/nanoclaw.log | grep -i "myplatform"

# Manual test: send message in platform
# Check if bot responds (check TRIGGER_PATTERN)
```

## Limitations & Gotchas

1. **Slack threads are flattened** — threaded replies appear as regular channel messages; responses go to channel, not back to thread
2. **Slack typing indicator unavailable** — can fake with "Working on it..." message
3. **Message length limits** — Slack 4000 chars, Feishu ~30KB; messages are chunked
4. **Credential management** — use `.env` + read with `readEnvFile()`, NOT `process.env`
5. **Rate limiting** — not handled by channel layer; rely on platform's SDK
6. **Network failures** — channels queue messages; no exponential backoff
7. **Metadata discovery** — optional; not all platforms require it

