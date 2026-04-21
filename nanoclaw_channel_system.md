# NanoClaw Channel System: Comprehensive Deep Dive

## Overview

NanoClaw uses a **modular channel abstraction** to support multiple messaging platforms (Slack, Feishu, WhatsApp, Telegram, etc.) with a unified interface. Channels self-register at startup and deliver inbound messages via callbacks to the core orchestrator.

### Philosophy
- **Zero configuration**: Channels are enabled/disabled by presence of credentials (env vars)
- **Auto-registration**: `src/channels/index.ts` imports channels, triggering their `registerChannel()` calls
- **Unified message flow**: All channels map platform-specific concepts to a common `NewMessage` type
- **Optional capabilities**: Advanced features (typing, reactions, sync) are optional interface methods

---

## Part 1: Core Interfaces (src/types.ts)

### The Channel Interface

```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  
  // Optional: add emoji reaction to a message.
  reactToMessage?(jid: string, messageId: string, emoji: string): Promise<void>;
  
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}
```

**Key Properties:**
- `name`: Channel identifier (e.g., "slack", "feishu")
- All methods are async (channels may make HTTP calls)
- Optional methods allow channels to feature-detect

### Message Types

```typescript
export interface NewMessage {
  id: string;                          // Platform-specific message ID
  chat_jid: string;                    // JID like "slack:C123456" or "feishu:chat_456"
  sender: string;                      // Platform user ID
  sender_name: string;                 // Human-readable name
  content: string;                     // Message text
  timestamp: string;                   // ISO 8601 timestamp
  is_from_me?: boolean;                // Whether message is from the bot
  is_bot_message?: boolean;            // Same as is_from_me (redundant but kept for compatibility)
  thread_id?: string;                  // Optional: thread parent ID
  reply_to_message_id?: string;        // Optional: message being replied to
  reply_to_message_content?: string;   // Optional: quoted text
  reply_to_sender_name?: string;       // Optional: original sender name
}
```

### Callback Types

```typescript
// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
```

---

## Part 2: Channel Registry (src/channels/registry.ts)

The registry implements a **factory pattern** for lazy channel initialization.

```typescript
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;  // Callback to fetch live groups
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

**Key Points:**
- `ChannelFactory` is a function that takes `ChannelOpts` and returns a `Channel | null`
  - Returns `null` if credentials are missing, allowing graceful degradation
- `ChannelOpts` passes in callbacks so channels can report inbound messages
- `registeredGroups()` is a **callback, not a snapshot** — allows channels to see live group registrations

---

## Part 3: Channel Loading (src/channels/index.ts)

The "barrel file" imports channels, triggering their self-registration.

```typescript
// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord
// feishu
import './feishu.js';

// gmail

// slack
import './slack.js';

// telegram

// whatsapp
```

**Mechanism:**
1. Each channel module (e.g., `slack.ts`) ends with:
   ```typescript
   registerChannel('slack', (opts: ChannelOpts) => {
     const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
     if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
       logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
       return null;  // Gracefully disabled if creds missing
     }
     return new SlackChannel(opts);
   });
   ```

2. When `src/channels/index.ts` is imported, these side-effects run and populate the registry

3. Core code can then call `getChannelFactory('slack')` to get the factory, invoke it, and start the channel

---

## Part 4: Channel Implementation Pattern

### Example 1: Slack (src/channels/slack.ts)

Slack uses **Socket Mode** (WebSocket-based) instead of webhooks, so no public URL is needed.

```typescript
import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

// Message size limit
const MAX_MESSAGE_LENGTH = 4000;

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private lastUserMessageTs = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off environment)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env');
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all subtypes
    // including bot_message (needed to track our own output and avoid loops)
    this.app.event('message', async ({ event }) => {
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      const msg = event as HandledMessageEvent;
      if (!msg.text) return;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Report metadata for discovery (even for unregistered groups)
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName = (msg.user ? await this.resolveUserName(msg.user) : undefined) || msg.user || 'unknown';
      }

      // Translate Slack <@UBOTID> mentions into trigger pattern
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
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

  async connect(): Promise<void> {
    await this.app.start();

    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;
    await this.flushOutgoingQueue();
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, queueSize: this.outgoingQueue.length }, 'Slack disconnected, message queued');
      return;
    }

    try {
      // Extract file references and upload them natively
      const { cleanText, filePaths } = this.extractFileReferences(jid, text);

      // Send text portion (chunk if needed)
      if (cleanText) {
        if (cleanText.length <= MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({ channel: channelId, text: cleanText });
        } else {
          for (let i = 0; i < cleanText.length; i += MAX_MESSAGE_LENGTH) {
            await this.app.client.chat.postMessage({
              channel: channelId,
              text: cleanText.slice(i, i + MAX_MESSAGE_LENGTH),
            });
          }
        }
      }

      // Upload files
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
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: `📎 File: ${path.basename(filePath)}`,
          });
        }
      }

      logger.info({ jid, length: text.length, fileCount: filePaths.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send Slack message, queued');
    }
  }

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

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Slack API doesn't expose a typing indicator endpoint for bots
    // So we use a "⏳ Working on it..." message instead (best-effort)
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
}

// Self-registration
registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;  // Gracefully disabled
  }
  return new SlackChannel(opts);
});
```

**Slack-Specific Patterns:**
- **Socket Mode**: WebSocket-based, no public URL needed
- **Message filtering**: Filters subtypes to avoid processing bot messages as user messages
- **Mention translation**: `<@BOTID>` → `@ASSISTANT_NAME` so trigger pattern matching works
- **Metadata sync**: Proactively fetches channel names on startup
- **Message queuing**: Queues messages sent before connection completes
- **File handling**: Extracts markdown image references and uploads via native API

---

### Example 2: Feishu (src/channels/feishu.ts)

Feishu uses **HTTP webhooks + SDK** and has a different philosophy: it **auto-registers unregistered groups**.

```typescript
import * as lark from '@larksuiteoapi/node-sdk';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client;
  private wsClient: lark.WSClient;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private processedMessages = new Set<string>();  // Dedup webhook re-pushes
  private workingMessageId = new Map<string, string>();
  private userNameCache = new Map<string, string>();
  private opts: FeishuChannelOpts;
  private dispatcher: lark.EventDispatcher;

  constructor(opts: FeishuChannelOpts) {
    this.opts = opts;

    const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
    const appId = env.FEISHU_APP_ID;
    const appSecret = env.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set in .env');
    }

    this.client = new lark.Client({ appId, appSecret });
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    this.dispatcher = new lark.EventDispatcher({});
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.dispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        logger.debug({ eventType: 'im.message.receive_v1' }, 'Feishu event received');
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Feishu message handler error');
        }
      },
    });
  }

  private async handleMessage(data: any): Promise<void> {
    const message = data?.message;
    if (!message) {
      logger.warn({ data }, 'Feishu: no message in event data');
      return;
    }

    const messageId = message.message_id;

    // Deduplicate — Feishu re-pushes if not acked within 3s
    if (this.processedMessages.has(messageId)) return;
    this.processedMessages.add(messageId);

    // Prune old message IDs (keep last 1000)
    if (this.processedMessages.size > 1000) {
      const ids = [...this.processedMessages];
      for (let i = 0; i < ids.length - 500; i++) {
        this.processedMessages.delete(ids[i]);
      }
    }

    const chatId = message.chat_id;
    if (!chatId) return;

    const jid = `feishu:${chatId}`;
    const timestamp = new Date(parseInt(message.create_time, 10) * 1000).toISOString();
    const chatType = message.chat_type;  // 'p2p' or 'group'
    const isGroup = chatType === 'group';

    // Report metadata for discovery
    this.opts.onChatMetadata(jid, timestamp, undefined, 'feishu', isGroup);

    // AUTO-REGISTER unregistered Feishu chats
    // This is different from Slack, which expects pre-registration
    let groups = this.opts.registeredGroups();
    if (!groups[jid]) {
      const chatName = (await this.resolveChatName(chatId)) || chatId;
      const safeName = chatName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || chatId.slice(0, 12);
      const folder = `feishu_${safeName}`;

      const group: RegisteredGroup = {
        name: chatName,
        folder,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      };

      setRegisteredGroup(jid, group);

      // Create group folder with CLAUDE.md from template
      const groupDir = path.join(GROUPS_DIR, folder);
      fs.mkdirSync(groupDir, { recursive: true });
      const mainTemplate = path.join(GROUPS_DIR, 'feishu_main', 'CLAUDE.md');
      const defaultTemplate = path.join(GROUPS_DIR, 'main', 'CLAUDE.md');
      const template = fs.existsSync(mainTemplate) ? mainTemplate
        : fs.existsSync(defaultTemplate) ? defaultTemplate
        : null;
      if (template) {
        fs.copyFileSync(template, path.join(groupDir, 'CLAUDE.md'));
      }

      // Refresh groups so this message gets processed
      const freshGroups = getAllRegisteredGroups();
      Object.assign(groups, freshGroups);

      logger.info({ jid, name: chatName, folder }, 'Feishu: auto-registered new chat');
    }

    // Parse message content — Feishu sends JSON strings
    let content = '';
    const msgType = message.message_type;
    if (msgType === 'text') {
      try {
        const parsed = JSON.parse(message.content);
        content = parsed.text || '';
      } catch {
        content = message.content || '';
      }
    } else {
      content = `[${msgType} message]`;
    }

    if (!content) return;

    // Get sender info
    const sender = data.sender;
    const senderId = sender?.sender_id?.open_id || sender?.sender_id?.user_id || '';
    const senderType = sender?.sender_type || '';
    const isBotMessage = senderType === 'app';

    let senderName: string;
    if (isBotMessage) {
      senderName = ASSISTANT_NAME;
    } else {
      senderName = (await this.resolveUserName(senderId)) || senderId;
    }

    // Translate @mentions to trigger pattern
    if (!isBotMessage) {
      const atPattern = /<at user_id="[^"]*">[^<]*<\/at>/g;
      if (atPattern.test(content) && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content.replace(atPattern, '').trim()}`;
      }
    }

    this.opts.onMessage(jid, {
      id: messageId,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
    });
  }

  async connect(): Promise<void> {
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
    this.connected = true;
    logger.info('Connected to Feishu');
    await this.flushOutgoingQueue();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^feishu:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, queueSize: this.outgoingQueue.length }, 'Feishu disconnected, message queued');
      return;
    }

    try {
      const { cleanText, filePaths } = this.extractFileReferences(jid, text);

      // Send text portion
      if (cleanText) {
        const chunks = this.splitText(cleanText);
        for (const chunk of chunks) {
          await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: chunk }),
            },
          });
        }
      }

      // Upload files (images separately from other files)
      for (const filePath of filePaths) {
        try {
          await this.uploadFile(chatId, filePath);
          logger.info({ jid, filename: path.basename(filePath) }, 'Feishu file uploaded');
        } catch (fileErr) {
          logger.warn({ jid, filePath, err: fileErr }, 'Failed to upload file to Feishu');
          await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: `📎 File: ${path.basename(filePath)}` }),
            },
          });
        }
      }

      logger.info({ jid, length: text.length, fileCount: filePaths.length }, 'Feishu message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send Feishu message, queued');
    }
  }

  async reactToMessage(jid: string, messageId: string, emoji: string): Promise<void> {
    try {
      await (this.client as any).im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
    } catch (err) {
      logger.warn({ jid, messageId, emoji, err }, 'Feishu reactToMessage error');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  if (!envVars.FEISHU_APP_ID || !envVars.FEISHU_APP_SECRET) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }
  return new FeishuChannel(opts);
});
```

**Feishu-Specific Patterns:**
- **Auto-registration**: Creates folder and registers group on first message
- **Webhook deduplication**: Tracks message IDs to handle Feishu's 3s re-push mechanism
- **Message format**: Sends text as JSON (`{ text: "..." }`)
- **Rich media**: Supports image upload (via separate API) and file upload
- **Emoji reactions**: Uses `reactToMessage()` to implement reactions (Slack doesn't expose this)
- **No typing indicator**: Uses no-op `setTyping()` instead

---

## Part 5: Key Patterns & Considerations

### 1. **JID Format**
Each channel defines its own JID prefix:
- Slack: `slack:C0123456789` (channel ID)
- Feishu: `feishu:oc_xxx` (chat ID)
- WhatsApp: `whatsapp:1234567890` (phone number)

### 2. **Message Flow**

```
1. Platform sends message → Channel event handler receives it
2. Handler parses platform-specific fields → Maps to NewMessage
3. Handler translates platform mentions to trigger pattern (@ASSISTANT_NAME)
4. Handler calls opts.onMessage(jid, NewMessage) → Core processes it
5. Core decides if message is for registered group + passes trigger check
6. Core composes response → Calls channel.sendMessage(jid, text)
7. Channel reformats response for platform + sends it
```

### 3. **Optional Capabilities Pattern**

```typescript
// Channel.setTyping is optional
if (channel.setTyping) {
  await channel.setTyping(jid, true);
}

// Channel.reactToMessage is optional
if (channel.reactToMessage) {
  await channel.reactToMessage(jid, messageId, '👍');
}

// Core code doesn't crash if these aren't implemented
```

### 4. **Credential Security**

Channels read credentials from `.env` using `readEnvFile()`, NOT `process.env`:

```typescript
const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
const botToken = env.SLACK_BOT_TOKEN;
```

This keeps secrets off the process environment to prevent leaks to child processes.

### 5. **Message Queuing**

Both Slack and Feishu queue outbound messages if the channel disconnects:

```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  if (!this.connected) {
    this.outgoingQueue.push({ jid, text });
    return;
  }
  // ... send via API
}
```

Then flush on reconnection:

```typescript
async connect(): Promise<void> {
  await this.wsClient.start(...);
  this.connected = true;
  await this.flushOutgoingQueue();  // Send queued messages
}
```

### 6. **Metadata Discovery**

Channels call `opts.onChatMetadata()` to report discovered groups, even if they're not registered yet:

```typescript
// Report for discovery
this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

// But only deliver messages for registered groups
const groups = this.opts.registeredGroups();
if (!groups[jid]) return;
```

This allows the core to discover and auto-register groups (as Feishu does) or display them to the user.

### 7. **Mention Translation**

Different platforms encode mentions differently:
- **Slack**: `<@U12345>` → translate to `@ASSISTANT_NAME`
- **Feishu**: `<at user_id="xxx">name</at>` → translate to `@ASSISTANT_NAME`

Each channel handles this before passing `content` to `opts.onMessage()`.

### 8. **File Handling**

Channels support uploading files by extracting markdown image references:

```typescript
private extractFileReferences(jid: string, text: string) {
  const filePaths: string[] = [];
  const imgPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  let cleanText = text.replace(imgPattern, (match, filePath: string) => {
    const hostPath = this.resolveContainerPath(jid, filePath.trim());
    if (hostPath) {
      filePaths.push(hostPath);
      return '';  // Remove markdown reference
    }
    return match;
  });
  return { cleanText, filePaths };
}
```

Then uploads each file:

```typescript
for (const filePath of filePaths) {
  await this.app.client.filesUploadV2({
    channel_id: channelId,
    file: fs.createReadStream(filePath),
    filename: path.basename(filePath),
  });
}
```

---

## Part 6: Adding a New Channel (Skill Pattern)

The `/add-slack` skill (`.claude/skills/add-slack/SKILL.md`) shows the standard flow:

### Phase 1: Pre-flight
- Check if code already exists (`src/channels/slack.ts`)
- Ask if user has credentials

### Phase 2: Apply Code Changes
- Merge skill branch from upstream repo
- Validates with `npm run build` and `npx vitest`

### Phase 3: Setup
- Create bot/app on the platform
- Generate API tokens
- Add to `.env` (and sync to `data/env/env` for container)

### Phase 4: Registration
- Get channel IDs from platform
- Register with `npx tsx setup/index.ts --step register`

### Phase 5: Verify
- User sends test message
- Logs checked if needed

### Key Insights for New Channels

1. **Implement the Channel interface** — at minimum:
   - `connect()`, `disconnect()`, `sendMessage()`, `isConnected()`, `ownsJid()`
   - Optional: `setTyping()`, `reactToMessage()`, `syncGroups()`

2. **Call registerChannel() at module load**:
   ```typescript
   registerChannel('myplatform', (opts) => {
     const env = readEnvFile(['MYPLATFORM_TOKEN']);
     if (!env.MYPLATFORM_TOKEN) return null;  // Gracefully disabled
     return new MyPlatformChannel(opts);
   });
   ```

3. **Add import to `src/channels/index.ts`**:
   ```typescript
   import './myplatform.js';
   ```

4. **Parse platform-specific fields into NewMessage**:
   - Translate platform mentions to trigger pattern
   - Handle message IDs, timestamps, sender info
   - Distinguish bot messages from user messages

5. **Report metadata for discovery**:
   ```typescript
   this.opts.onChatMetadata(jid, timestamp, name?, 'myplatform', isGroup);
   ```

6. **Implement graceful message queuing** if your platform can disconnect

---

## Part 7: CONTRIBUTING.md Guidelines

From `CONTRIBUTING.md`:

### Skill Types

1. **Feature Skills (branch-based)**
   - Code lives on `skill/<name>` branch
   - SKILL.md instructions on `main` point to the branch
   - Example: `/add-telegram`, `/add-slack`
   - Best for major features like new channels

2. **Utility Skills (with code files)**
   - Code in `.claude/skills/<name>/` directory
   - No branch merge needed
   - Example: `/claw` CLI tool

3. **Operational Skills (instruction-only)**
   - Pure workflow instructions
   - No code changes
   - Example: `/setup`, `/debug`, `/customize`

4. **Container Skills (agent runtime)**
   - Code in `container/skills/<name>/`
   - Loaded by agent inside container
   - Example: `agent-browser`, `slack-formatting`

### PR Guidelines

- **One thing per PR** — one bug fix, one skill, one simplification
- **Bug fixes/security fixes** → source code only
- **Features/capabilities** → skills only (branch-based or utility)
- **Testing** — skills tested on fresh clone
- **Descriptions** — brief, clear (3-4 sentences max)

---

## Summary

| Aspect | Details |
|--------|---------|
| **Core Interface** | `Channel` interface with required and optional methods |
| **Registration** | Factory pattern in `registry.ts`; channels self-register on module load |
| **Loading** | Barrel file imports at startup trigger `registerChannel()` calls |
| **Message Flow** | Platform → Channel handler → `opts.onMessage()` → Core → `sendMessage()` |
| **Graceful Degradation** | Missing credentials return `null` from factory; channel is skipped |
| **Metadata Discovery** | Channels report discovered groups even if not registered (optional) |
| **Mention Translation** | Each channel translates platform-specific mentions to `@ASSISTANT_NAME` |
| **File Handling** | Extract markdown images, upload to platform, fall back to text on failure |
| **Message Queuing** | Queue outbound messages on disconnect, flush on reconnection |
| **New Channels** | Create class, implement interface, call `registerChannel()`, add import |

