# NanoClaw Channel Integration Pattern - Complete Analysis

## Overview
NanoClaw uses a plugin architecture where channels (Slack, WhatsApp, Telegram, etc.) are self-registering modules. Each channel implements a standard `Channel` interface and registers itself via a factory function. The system is designed to be extensible and multi-channel-capable.

---

## 1. Core Type Definitions (src/types.ts)

### Channel Interface
```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional methods
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

**Key Points:**
- `name`: Channel identifier (e.g., "slack", "telegram")
- `connect()`: Initialize connection (socket, webhook, polling)
- `sendMessage()`: Send message to a group/chat
- `isConnected()`: Check connection status
- `ownsJid()`: Determine if this channel handles a given JID (e.g., "slack:C123ABC")
- `disconnect()`: Clean shutdown
- `setTyping?`: Optional—typing indicator support
- `syncGroups?`: Optional—discover/sync group names from platform

### Callback Types
```typescript
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean;
  isMain?: boolean;
}
```

---

## 2. Channel Registry Pattern (src/channels/registry.ts)

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
```

**How It Works:**
1. Each channel module calls `registerChannel(name, factory)` at module load time
2. The factory is a function that takes `ChannelOpts` and returns a `Channel` instance or `null`
3. The factory can check `.env` for credentials and return `null` if missing (graceful disable)
4. Later, `getChannelFactory()` is used to instantiate channels

---

## 3. Slack Channel Implementation (src/channels/slack.ts)

### Class Structure
```typescript
export class SlackChannel implements Channel {
  name = 'slack';
  
  private app: App; // @slack/bolt App instance
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private lastUserMessageTs = new Map<string, string>();
  private opts: SlackChannelOpts;
```

### Constructor
```typescript
constructor(opts: SlackChannelOpts) {
  this.opts = opts;
  
  // Read credentials from .env file (NOT process.env — security pattern)
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  const botToken = env.SLACK_BOT_TOKEN;
  const appToken = env.SLACK_APP_TOKEN;
  
  if (!botToken || !appToken) {
    throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env');
  }
  
  this.app = new App({
    token: botToken,
    appToken,
    socketMode: true, // No public webhook needed
    logLevel: LogLevel.ERROR,
  });
  
  this.setupEventHandlers();
}
```

**Security Patterns:**
- Uses `readEnvFile()` instead of `process.env` to keep secrets from child processes
- Credentials are NOT stored in memory longer than needed
- Container agents receive credentials via OneCLI gateway, never directly

### Event Handler Setup
```typescript
private setupEventHandlers(): void {
  this.app.event('message', async ({ event }) => {
    const subtype = (event as { subtype?: string }).subtype;
    if (subtype && subtype !== 'bot_message') return;
    
    const msg = event as HandledMessageEvent;
    if (!msg.text) return;
    
    const jid = `slack:${msg.channel}`;
    const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
    const isGroup = msg.channel_type !== 'im';
    
    // Always report metadata for group discovery
    this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);
    
    // Only deliver full messages for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;
    
    const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;
    
    // Resolve user name from cache or API
    let senderName: string;
    if (isBotMessage) {
      senderName = ASSISTANT_NAME;
    } else {
      senderName = (msg.user ? await this.resolveUserName(msg.user) : undefined) || msg.user || 'unknown';
    }
    
    // Translate Slack <@UBOTID> mentions to @AssistantName format
    let content = msg.text;
    if (this.botUserId && !isBotMessage) {
      const mentionPattern = `<@${this.botUserId}>`;
      if (content.includes(mentionPattern) && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }
    
    this.opts.onMessage(jid, {
      id: msg.ts,
      chat_jid: jid,
      sender: msg.user || msg.bot_id || '',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
    });
  });
}
```

**Key Behaviors:**
- Filters to regular messages and bot_message subtypes
- Reports metadata for ALL messages (even unregistered groups) for discovery
- Only delivers full messages to registered groups
- Detects self-sent messages via `botUserId`
- Translates Slack mention syntax to trigger format
- Resolves user names asynchronously with caching

### Connection
```typescript
async connect(): Promise<void> {
  await this.app.start(); // Start Socket Mode
  
  try {
    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id as string;
    logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
  } catch (err) {
    logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
  }
  
  this.connected = true;
  await this.flushOutgoingQueue(); // Send queued messages
  await this.syncChannelMetadata(); // Sync channel names
}
```

### Message Sending
```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  const channelId = jid.replace(/^slack:/, '');
  
  if (!this.connected) {
    this.outgoingQueue.push({ jid, text });
    logger.info({ jid, queueSize: this.outgoingQueue.length }, 'Slack disconnected, message queued');
    return;
  }
  
  try {
    // Extract markdown image references: ![alt](/workspace/group/path)
    const { cleanText, filePaths } = this.extractFileReferences(jid, text);
    
    // Send text in chunks if needed (Slack API limit: ~4000 chars)
    if (cleanText) {
      if (cleanText.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: cleanText,
        });
      } else {
        for (let i = 0; i < cleanText.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: cleanText.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
    }
    
    // Upload files natively to Slack
    for (const filePath of filePaths) {
      try {
        const filename = path.basename(filePath);
        await this.app.client.filesUploadV2({
          channel_id: channelId,
          file: fs.createReadStream(filePath),
          filename,
          title: filename,
        });
        logger.info({ jid, filename }, 'Slack file uploaded');
      } catch (fileErr) {
        logger.warn({ jid, filePath, err: fileErr }, 'Failed to upload file to Slack');
        // Fallback: send filename as text
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: `📎 File: ${path.basename(filePath)}`,
        });
      }
    }
  } catch (err) {
    this.outgoingQueue.push({ jid, text });
    logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send Slack message, queued');
  }
}
```

**Key Patterns:**
- JID format: `slack:{channelId}`
- Message queuing for pre-connection sends
- Chunk large messages (API limit)
- Extract and upload files natively
- Fallback to text filename if upload fails

### Typing Indicator
```typescript
private workingMessageTs = new Map<string, string>();

async setTyping(jid: string, isTyping: boolean): Promise<void> {
  const channelId = jid.replace(/^slack:/, '');
  
  try {
    if (isTyping) {
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text: '⏳ Working on it…',
      });
      if (result.ts) {
        this.workingMessageTs.set(jid, result.ts);
      }
    } else {
      const ts = this.workingMessageTs.get(jid);
      if (ts) {
        await this.app.client.chat.delete({ channel: channelId, ts });
        this.workingMessageTs.delete(jid);
      }
    }
  } catch {
    // Ignore — best-effort indicator
  }
}
```

**Note:** Slack doesn't have a true typing indicator for bots, so NanoClaw uses a "Working on it…" message that's deleted when done.

### Group Metadata Sync
```typescript
async syncChannelMetadata(): Promise<void> {
  try {
    logger.info('Syncing channel metadata from Slack...');
    let cursor: string | undefined;
    let count = 0;
    
    do {
      const result = await this.app.client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      
      for (const ch of result.channels || []) {
        if (ch.id && ch.name && ch.is_member) {
          updateChatName(`slack:${ch.id}`, ch.name);
          count++;
        }
      }
      
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    
    logger.info({ count }, 'Slack channel metadata synced');
  } catch (err) {
    logger.error({ err }, 'Failed to sync Slack channel metadata');
  }
}
```

### Ownership Check
```typescript
isConnected(): boolean {
  return this.connected;
}

ownsJid(jid: string): boolean {
  return jid.startsWith('slack:');
}

async disconnect(): Promise<void> {
  this.connected = false;
  await this.app.stop();
}
```

### Self-Registration
```typescript
// At module bottom
registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null; // Gracefully disable
  }
  return new SlackChannel(opts);
});
```

---

## 4. Channel Initialization (src/channels/index.ts)

```typescript
// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord
// gmail
// slack
import './slack.js';
// telegram
// whatsapp
```

**Pattern:**
- Barrel file that imports all channel modules
- Each import triggers module-level `registerChannel()` calls
- Commented slots for future channels (Discord, Gmail, Telegram, WhatsApp)

---

## 5. Container Credential Injection (src/container-runner.ts)

### Slack-Specific Environment Variables
```typescript
// Pass Slack credentials into the container so the agent can upload files directly.
if (chatJid?.startsWith('slack:') && process.env.SLACK_BOT_TOKEN) {
  const channelId = chatJid.replace(/^slack:/, '');
  args.push('-e', `SLACK_BOT_TOKEN=${process.env.SLACK_BOT_TOKEN}`);
  args.push('-e', `SLACK_CHANNEL_ID=${channelId}`);
}
```

**Location:** Lines 307-312 in `container-runner.ts`

**Key Points:**
- Credentials are passed as environment variables only when:
  1. The chat JID is a Slack channel (`slack:`)
  2. The credential exists in the host environment
- The channel ID is extracted from the JID and passed to the container
- This allows agents to call Slack APIs directly (e.g., for file uploads)

---

## 6. Main Application Integration (src/index.ts)

### Channel Imports and Registration
```typescript
import './channels/index.js'; // Triggers all registerChannel() calls
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
```

### Channel Instantiation in main()
```typescript
// Create and connect all registered channels.
// Each channel self-registers via the barrel import above.
// Factories return null when credentials are missing, so unconfigured channels are skipped.
for (const channelName of getRegisteredChannelNames()) {
  const factory = getChannelFactory(channelName)!;
  const channel = factory(channelOpts);
  if (!channel) {
    logger.warn(
      { channel: channelName },
      'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
    );
    continue;
  }
  channels.push(channel);
  await channel.connect();
}
if (channels.length === 0) {
  logger.fatal('No channels connected');
  process.exit(1);
}
```

### Channel Options (Callbacks)
```typescript
const channelOpts = {
  onMessage: (chatJid: string, msg: NewMessage) => {
    // Remote control commands — intercept before storage
    const trimmed = msg.content.trim();
    if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
      handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
        logger.error({ err, chatJid }, 'Remote control command error'),
      );
      return;
    }
    
    // Sender allowlist drop mode: discard messages from denied senders
    if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
      const cfg = loadSenderAllowlist();
      if (
        shouldDropMessage(chatJid, cfg) &&
        !isSenderAllowed(chatJid, msg.sender, cfg)
      ) {
        if (cfg.logDenied) {
          logger.debug({ chatJid, sender: msg.sender }, 'sender-allowlist: dropping message (drop mode)');
        }
        return;
      }
    }
    storeMessage(msg);
  },
  onChatMetadata: (chatJid, timestamp, name?, channel?, isGroup?) =>
    storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
  registeredGroups: () => registeredGroups,
};
```

### Message Processing via Channel
```typescript
// In processGroupMessages():
const channel = findChannel(channels, chatJid);
if (!channel) {
  logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
  return true;
}

// ... process messages ...

await channel.setTyping?.(chatJid, true);
let hadError = false;
let outputSentToUser = false;

const output = await runAgent(group, prompt, chatJid, async (result) => {
  if (result.result) {
    const text = result.result.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
    if (text) {
      await channel.sendMessage(chatJid, text); // <-- Send via channel
      outputSentToUser = true;
    }
    resetIdleTimer();
  }
  // ...
});

await channel.setTyping?.(chatJid, false);
```

### Finding the Right Channel
```typescript
// From router.ts (imported as `findChannel`)
function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((ch) => ch.ownsJid(jid));
}
```

---

## 7. Environment Variable Security Pattern (src/env.ts)

```typescript
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }
  
  const result: Record<string, string> = {};
  const wanted = new Set(keys);
  
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }
  
  return result;
}
```

**Security Benefits:**
1. Reads only requested keys (whitelist, not all env vars)
2. Does NOT load into `process.env` (prevents leakage to child processes)
3. Returns only a local object that goes out of scope
4. Caller decides how to use the values (further compartmentalization)

---

## 8. Full Message Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SLACK EVENT (Socket Mode)                        │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  app.event('message')   │
                    │  (Slack Bolt handler)   │
                    └────────────┬────────────┘
                                 │
                    ┌────────────────────────────────┐
                    │ 1. Extract event metadata       │
                    │ 2. Build JID: slack:{channelId}│
                    │ 3. Timestamp convert           │
                    └────────────┬───────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ onChatMetadata(jid, ts, undefined,     │
                    │   'slack', isGroup)                    │
                    │ → storeChatMetadata() in DB            │
                    └────────────┬───────────────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ Check: registeredGroups[jid]?          │
                    │ If not registered, stop here           │
                    └────────────┬───────────────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ Resolve sender name                     │
                    │ Translate mention syntax               │
                    │ Mark as bot/user message               │
                    └────────────┬───────────────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ onMessage(jid, NewMessage {            │
                    │   id: msg.ts,                          │
                    │   chat_jid: jid,                       │
                    │   sender: msg.user,                    │
                    │   sender_name: resolved_name,          │
                    │   content: translated_text,            │
                    │   is_from_me: isBotMessage,            │
                    │   ...                                  │
                    │ })                                     │
                    └────────────┬───────────────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ → storeMessage() in DB                 │
                    │ → updateSenderAllowlist checks         │
                    │ → Message loop picks it up             │
                    └────────────┬───────────────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ Message loop detects trigger + calls   │
                    │ processGroupMessages() → runAgent()    │
                    └────────────┬───────────────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ channel.setTyping(jid, true)           │
                    │ → Posts "⏳ Working on it…"            │
                    └────────────┬───────────────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ runContainerAgent(group, prompt, ...)  │
                    │ → Passes SLACK_BOT_TOKEN,              │
                    │   SLACK_CHANNEL_ID into container      │
                    └────────────┬───────────────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ Agent generates response               │
                    │ (streaming via onOutput callback)      │
                    └────────────┬───────────────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ onOutput callback called per chunk:    │
                    │ await channel.sendMessage(jid, text)   │
                    │ → app.client.chat.postMessage()        │
                    │ → (or filesUploadV2 for files)         │
                    └────────────┬───────────────────────────┘
                                 │
                    ┌────────────────────────────────────────┐
                    │ channel.setTyping(jid, false)          │
                    │ → Deletes "⏳ Working on it…"          │
                    │   message                              │
                    └────────────────────────────────────────┘
```

---

## 9. JID Format Convention

**Pattern:** `{channelType}:{channelIdentifier}`

**Examples:**
- `slack:C1234567` → Slack channel ID
- `slack:D1234567` → Slack DM ID
- `telegram:123456789` → Telegram chat ID
- `whatsapp:1234567890` → WhatsApp phone/group ID

**Usage:**
- `ownsJid(jid)`: Check if channel owns this JID
- `jid.replace(/^slack:/, '')`: Extract channel ID from JID
- `extractFileReferences(jid, text)`: Resolve file paths using registered groups

---

## 10. Testing Pattern (Slack)

From `slack.test.ts`, the test suite:
1. Mocks `@slack/bolt` App
2. Tests event handler with synthetic message events
3. Verifies callbacks (onMessage, onChatMetadata)
4. Tests JID ownership, connection state
5. Tests message sending, queuing, chunking
6. Tests user name resolution and caching
7. Tests file extraction and upload

---

## 11. Key Security & Reliability Patterns

### Security
1. **Secret Management**
   - Use `readEnvFile()` to load only needed secrets
   - Never expose in `process.env`
   - Secrets go out of scope after use

2. **Container Isolation**
   - Credentials passed via environment variables only when needed
   - OneCLI gateway handles token injection (not NanoClaw itself)
   - Per-group sessions prevent cross-group access

3. **Message Validation**
   - Check `registeredGroups` before delivering full messages
   - Bot-sent messages detected by `botUserId`
   - Sender allowlist filtering at entry

### Reliability
1. **Message Queuing**
   - Pre-connection: messages queued and flushed on connect
   - Send failure: message re-queued for retry

2. **Typing Indicators**
   - Best-effort (Slack doesn't have true bot typing)
   - Uses message post/delete for visual feedback
   - Caught errors ignored (optional feature)

3. **Metadata Sync**
   - Pagination support for large workspace
   - Separates group discovery from message routing

4. **Connection Management**
   - Graceful startup (missing creds → null return → skip)
   - Graceful shutdown via `disconnect()`
   - Idle timeout in container runner

---

## 12. Extensibility Checklist for New Channels (e.g., Feishu/Lark)

To add a new channel, implement:

### 1. **Create `src/channels/{lark|feishu}.ts`**
   - [ ] Implement `Channel` interface
   - [ ] Constructor: read env vars via `readEnvFile()`
   - [ ] `connect()`: initialize connection (webhook/socket/polling)
   - [ ] `setupEventHandlers()`: listen for inbound messages
   - [ ] `sendMessage(jid, text)`: use platform API to post
   - [ ] `ownsJid(jid)`: check if JID is `feishu:{id}` format
   - [ ] `isConnected()`: return boolean
   - [ ] `disconnect()`: clean shutdown
   - [ ] Optional: `setTyping(jid, isTyping)` for typing indicator
   - [ ] Optional: `syncGroups(force)` for group discovery
   - [ ] Module bottom: `registerChannel(name, factory)`

### 2. **Update `src/channels/index.ts`**
   - [ ] Add import: `import './feishu.js';`

### 3. **Update `.env` template**
   - [ ] Add credentials: `FEISHU_BOT_TOKEN=...`, etc.

### 4. **Update `src/container-runner.ts` (optional)**
   - [ ] If agents need to call Feishu APIs directly, add credential injection:
     ```typescript
     if (chatJid?.startsWith('feishu:') && process.env.FEISHU_BOT_TOKEN) {
       const channelId = chatJid.replace(/^feishu:/, '');
       args.push('-e', `FEISHU_BOT_TOKEN=${process.env.FEISHU_BOT_TOKEN}`);
       args.push('-e', `FEISHU_CHANNEL_ID=${channelId}`);
     }
     ```

### 5. **Testing**
   - [ ] Unit tests for connection, message sending, event handling
   - [ ] Mock the platform SDK (e.g., `lark-js-sdk`)
   - [ ] Test graceful degradation (missing creds → null factory return)

---

## 13. Configuration Files

### Required `.env` entries for Slack
```
SLACK_BOT_TOKEN=xoxb-your-token-here
SLACK_APP_TOKEN=xapp-your-token-here
```

### Optional: Group-specific config (in group's CLAUDE.md or settings)
```json
{
  "containerConfig": {
    "timeout": 300000,
    "additionalMounts": [
      {
        "hostPath": "~/projects",
        "containerPath": "/workspace/extra/projects",
        "readonly": true
      }
    ]
  }
}
```

---

## Summary

**The complete pattern:**

1. **Channels are self-registering modules** that implement `Channel` interface
2. **Registry pattern** allows dynamic instantiation and graceful disable
3. **Callback-based messaging** (onMessage, onChatMetadata) decouples channel from core logic
4. **JID format** (`{type}:{id}`) enables multi-channel routing
5. **Secure env var handling** keeps credentials isolated from child processes
6. **Container credential injection** allows agents to call platform APIs directly
7. **Connection management** handles startup, queuing, and shutdown gracefully
8. **Optional features** (typing, sync) don't break if missing

To add Feishu/Lark, follow the checklist above—implementing the `Channel` interface, registering via factory, and optionally injecting credentials into the container.

