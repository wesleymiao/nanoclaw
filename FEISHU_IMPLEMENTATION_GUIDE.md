# Feishu/Lark Channel Implementation Guide

Based on the complete NanoClaw channel pattern analysis, here's the step-by-step guide to implement Feishu/Lark channel support.

## Quick Reference: What You Need to Implement

### 1. **Channel Class** (`src/channels/feishu.ts`)
A TypeScript class that:
- Implements the `Channel` interface (name, connect, sendMessage, etc.)
- Uses Feishu SDK to connect and receive messages
- Translates Feishu events to NanoClaw's `NewMessage` format
- Registers itself via the factory pattern

### 2. **Registration** (`src/channels/index.ts`)
- Add one import line: `import './feishu.js';`

### 3. **Container Credential Injection** (`src/container-runner.ts`)
- Optional: Add code to pass `FEISHU_BOT_TOKEN` and `FEISHU_CHANNEL_ID` to containers

### 4. **Tests** (`src/channels/feishu.test.ts`)
- Mock the Feishu SDK
- Test connection, message sending, event handling

---

## Detailed Implementation Steps

### Step 1: Create the Feishu Channel Class

**File: `src/channels/feishu.ts`**

The class needs:

#### a) Interface Implementation & Properties
```typescript
import { /* Feishu SDK */ } from '@larksuite/node-sdk';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const MAX_MESSAGE_LENGTH = 4000; // Adjust based on Feishu API limits

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';
  
  private client: /* Feishu SDK client */;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private opts: FeishuChannelOpts;
```

**Key differences from Slack:**
- Feishu uses different SDK (Lark SDK for JavaScript)
- Message structure is different (different field names)
- Chat ID format may be different
- Typing indicator implementation may differ

#### b) Constructor
```typescript
constructor(opts: FeishuChannelOpts) {
  this.opts = opts;
  
  // Read credentials from .env file (security pattern from NanoClaw)
  const env = readEnvFile(['FEISHU_BOT_TOKEN', 'FEISHU_ENCRYPT_KEY', 'FEISHU_VERIFICATION_TOKEN']);
  const botToken = env.FEISHU_BOT_TOKEN;
  const encryptKey = env.FEISHU_ENCRYPT_KEY;
  const verificationToken = env.FEISHU_VERIFICATION_TOKEN;
  
  if (!botToken) {
    throw new Error('FEISHU_BOT_TOKEN must be set in .env');
  }
  
  // Initialize Feishu client
  this.client = new /* FeishuClient */({
    appId: botToken.split(':')[0] || '', // Parse if needed
    appSecret: botToken.split(':')[1] || '', // Parse if needed
    // Other config...
  });
  
  this.setupEventHandlers();
}
```

**Important:** 
- Feishu may use different auth methods (App ID + Secret vs single token)
- Adjust `readEnvFile()` keys based on your Feishu app credentials
- Encryption/verification keys may be needed for webhook validation

#### c) Event Handler Setup
```typescript
private setupEventHandlers(): void {
  // Feishu can use webhooks or polling — choose based on your needs
  
  // Option 1: Webhook-based (more efficient)
  // Set up HTTP server to receive Feishu webhook events
  
  // Option 2: Polling-based (simpler for PoC)
  // Poll Feishu API for new messages periodically
  
  // Message handler logic:
  // 1. Parse Feishu event → extract chat_id, message_id, sender, text, timestamp
  // 2. Build JID: `feishu:{chat_id}`
  // 3. Call `this.opts.onChatMetadata()` for group discovery
  // 4. Check `registeredGroups` — only process if registered
  // 5. Resolve sender name (from Feishu user info)
  // 6. Detect bot-sent messages
  // 7. Call `this.opts.onMessage()` with NewMessage object
}
```

**Key logic from Slack (apply to Feishu):**
```typescript
// Always report metadata (even for unregistered groups)
const jid = `feishu:${chatId}`;
const isGroup = /* determine from Feishu event */;
this.opts.onChatMetadata(jid, timestamp, undefined, 'feishu', isGroup);

// Only deliver full messages for registered groups
const groups = this.opts.registeredGroups();
if (!groups[jid]) return;

// Detect bot-sent messages and resolve sender name
const isBotMessage = /* check if message is from bot */;
let senderName = isBotMessage ? ASSISTANT_NAME : /* resolve from user ID */;

// Call onMessage callback
this.opts.onMessage(jid, {
  id: messageId,
  chat_jid: jid,
  sender: userId,
  sender_name: senderName,
  content: messageText,
  timestamp,
  is_from_me: isBotMessage,
  is_bot_message: isBotMessage,
});
```

#### d) Connection
```typescript
async connect(): Promise<void> {
  try {
    // Initialize connection (webhook server, polling, etc.)
    // Get bot's own user ID for self-message detection
    const botInfo = await this.client.auth.test(); // Or equivalent Feishu API call
    this.botUserId = botInfo.user_id;
    logger.info({ botUserId: this.botUserId }, 'Connected to Feishu');
  } catch (err) {
    logger.warn({ err }, 'Connected to Feishu but failed to get bot user ID');
  }
  
  this.connected = true;
  await this.flushOutgoingQueue();
  await this.syncGroupMetadata();
}
```

#### e) Message Sending
```typescript
async sendMessage(jid: string, text: string): Promise<void> {
  const chatId = jid.replace(/^feishu:/, '');
  
  if (!this.connected) {
    this.outgoingQueue.push({ jid, text });
    logger.info({ jid, queueSize: this.outgoingQueue.length }, 'Feishu disconnected, message queued');
    return;
  }
  
  try {
    // Extract file references from markdown (same pattern as Slack)
    const { cleanText, filePaths } = this.extractFileReferences(jid, text);
    
    // Send text (may need chunking depending on Feishu API limits)
    if (cleanText) {
      if (cleanText.length <= MAX_MESSAGE_LENGTH) {
        await this.client.im.create({
          chat_id: chatId,
          msg_type: 'text',
          content: { text: cleanText },
        });
      } else {
        // Chunk large messages
        for (let i = 0; i < cleanText.length; i += MAX_MESSAGE_LENGTH) {
          await this.client.im.create({
            chat_id: chatId,
            msg_type: 'text',
            content: { text: cleanText.slice(i, i + MAX_MESSAGE_LENGTH) },
          });
        }
      }
    }
    
    // Upload files if any
    for (const filePath of filePaths) {
      try {
        // Feishu file upload API
        const response = await this.client.im.create({
          chat_id: chatId,
          msg_type: 'file',
          content: { /* file upload payload */ },
        });
        logger.info({ jid, filename: path.basename(filePath) }, 'Feishu file uploaded');
      } catch (fileErr) {
        logger.warn({ jid, filePath, err: fileErr }, 'Failed to upload file to Feishu');
        // Fallback to text
        await this.client.im.create({
          chat_id: chatId,
          msg_type: 'text',
          content: { text: `📎 File: ${path.basename(filePath)}` },
        });
      }
    }
  } catch (err) {
    this.outgoingQueue.push({ jid, text });
    logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send Feishu message, queued');
  }
}
```

#### f) Remaining Methods
```typescript
async setTyping(jid: string, isTyping: boolean): Promise<void> {
  // Optional: implement if Feishu supports typing indicators
  // Similar to Slack "Working on it…" pattern if needed
  // Can be a no-op if not supported
}

async syncGroupMetadata(): Promise<void> {
  // Fetch all groups bot is member of and sync names to DB
  // Use pagination for large workspaces
  // Call updateChatName(`feishu:{chatId}`, name) for each
}

isConnected(): boolean {
  return this.connected;
}

ownsJid(jid: string): boolean {
  return jid.startsWith('feishu:');
}

async disconnect(): Promise<void> {
  this.connected = false;
  // Clean up webhook server or polling loop
}
```

#### g) Self-Registration
```typescript
// At module bottom:
registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['FEISHU_BOT_TOKEN']);
  if (!envVars.FEISHU_BOT_TOKEN) {
    logger.warn('Feishu: FEISHU_BOT_TOKEN not set');
    return null;
  }
  return new FeishuChannel(opts);
});
```

---

### Step 2: Update Channel Registration

**File: `src/channels/index.ts`**

Add one line:
```typescript
// Channel self-registration barrel file.
// discord
// gmail
// slack
import './slack.js';
// feishu
import './feishu.js';  // <- ADD THIS LINE
// telegram
// whatsapp
```

---

### Step 3: Optional — Container Credential Injection

**File: `src/container-runner.ts` (lines ~307-312)**

If you want agents to call Feishu APIs directly, add:
```typescript
// Pass Feishu credentials into the container so the agent can interact with Feishu directly.
if (chatJid?.startsWith('feishu:') && process.env.FEISHU_BOT_TOKEN) {
  const chatId = chatJid.replace(/^feishu:/, '');
  args.push('-e', `FEISHU_BOT_TOKEN=${process.env.FEISHU_BOT_TOKEN}`);
  args.push('-e', `FEISHU_CHAT_ID=${chatId}`);
}
```

---

### Step 4: Update .env Template

Add to your `.env.example` or documentation:
```
# Feishu / Lark
FEISHU_BOT_TOKEN=your_app_id:your_app_secret
FEISHU_ENCRYPT_KEY=optional_encryption_key
FEISHU_VERIFICATION_TOKEN=optional_verification_token
```

---

### Step 5: Write Tests

**File: `src/channels/feishu.test.ts`**

Test structure (similar to `slack.test.ts`):
1. Mock the Feishu SDK
2. Test event handler with synthetic messages
3. Verify callbacks (onMessage, onChatMetadata)
4. Test JID ownership, connection state
5. Test message sending, queuing, chunking
6. Test user name resolution
7. Test file extraction and upload

---

## Key Differences: Slack vs Feishu

| Aspect | Slack | Feishu |
|--------|-------|--------|
| **SDK** | `@slack/bolt` | `@larksuite/node-sdk` |
| **Auth** | Bot Token + App Token | App ID + App Secret |
| **Events** | Socket Mode | Webhook or polling |
| **Message ID** | `ts` (timestamp string) | `message_id` |
| **Chat ID** | Channel ID (C...) or DM ID (D...) | Chat ID |
| **Mention format** | `<@USERID>` | Could be different |
| **File upload** | `filesUploadV2` API | Different Feishu API |
| **Typing indicator** | No native API | May differ |
| **Group sync** | `conversations.list` | Different API endpoint |

---

## Integration Checklist

- [ ] Create `src/channels/feishu.ts` with `FeishuChannel` class
- [ ] Implement `Channel` interface (all required + optional methods)
- [ ] Test credential reading via `readEnvFile()`
- [ ] Test event handler with sample Feishu messages
- [ ] Test JID format and `ownsJid()` logic
- [ ] Test message sending and queuing
- [ ] Add import to `src/channels/index.ts`
- [ ] Create `src/channels/feishu.test.ts` with comprehensive tests
- [ ] Optional: Add credential injection to `src/container-runner.ts`
- [ ] Update `.env.example` with Feishu credentials
- [ ] Verify registration: check `getRegisteredChannelNames()` includes 'feishu'
- [ ] Test end-to-end: register a group on Feishu and send messages

---

## Debugging Tips

1. **Missing credentials?** Check `.env` file and exact key names
2. **Event handler not firing?** Verify webhook URL or polling setup
3. **Messages not stored?** Check that group is registered in NanoClaw DB
4. **No output?** Set `LOG_LEVEL=debug` in environment
5. **JID format wrong?** Verify `feishu:` prefix and chat ID format

---

## References

- **NanoClaw Pattern Analysis**: See `CHANNEL_PATTERN.md` in project root
- **Slack Implementation**: `src/channels/slack.ts` (reference)
- **Types**: `src/types.ts` (Channel interface definition)
- **Registry**: `src/channels/registry.ts` (factory pattern)

---

## Next Steps

1. Review `CHANNEL_PATTERN.md` for complete pattern details
2. Install Feishu SDK: `npm install @larksuite/node-sdk`
3. Create `src/channels/feishu.ts` following the structure above
4. Implement Feishu API calls based on SDK documentation
5. Write tests to verify behavior
6. Test integration with NanoClaw main app

Good luck! 🚀
