# NanoClaw Channel System Documentation Index

## Quick Navigation

### 📋 Start Here
- **[CHANNEL_QUICK_START.md](CHANNEL_QUICK_START.md)** (5 min read)
  - TL;DR of how channels work
  - Core interfaces & message types
  - Key patterns with code examples
  - Common gotchas checklist

### 🔧 Implementation Guide
- **[nanoclaw_channel_system.md](nanoclaw_channel_system.md)** (30 min read)
  - Complete deep dive with all code snippets
  - Part 1: Core Interfaces (src/types.ts)
  - Part 2: Channel Registry (src/channels/registry.ts)
  - Part 3: Channel Loading (src/channels/index.ts)
  - Part 4: Implementation Examples (Slack & Feishu)
  - Part 5: Key Patterns & Considerations
  - Part 6: Adding a New Channel (Skill Pattern)
  - Part 7: CONTRIBUTING.md Guidelines

### 📊 Reference & Architecture
- **[channel_architecture_summary.md](channel_architecture_summary.md)** (15 min read)
  - Architecture diagrams
  - Message flow sequence diagram
  - Registry & factory pattern visualization
  - JID format reference
  - Slack vs Feishu comparison table
  - Common patterns with code
  - Testing & troubleshooting guide

### 📑 Exploration Summary
- **[EXPLORATION_SUMMARY.txt](EXPLORATION_SUMMARY.txt)** (Executive summary)
  - 10 key findings from the exploration
  - Architecture highlights (strengths & limitations)
  - Checklist for adding new channels
  - Complete code snippet examples
  - CONTRIBUTING.md guidelines

---

## How to Use These Docs

### If you want to...

**Understand channels in 5 minutes**
→ Read [CHANNEL_QUICK_START.md](CHANNEL_QUICK_START.md) (first 3 sections)

**Implement a new channel**
→ Use [CHANNEL_QUICK_START.md](CHANNEL_QUICK_START.md) checklist + [nanoclaw_channel_system.md](nanoclaw_channel_system.md) Part 6

**Debug a channel issue**
→ Check [channel_architecture_summary.md](channel_architecture_summary.md) Limitations & Gotchas section

**Learn the full architecture**
→ Read [nanoclaw_channel_system.md](nanoclaw_channel_system.md) in order

**Reference code patterns**
→ Use [channel_architecture_summary.md](channel_architecture_summary.md) Common Patterns section

**Add Slack/Feishu to NanoClaw**
→ Run `/add-slack` or `/add-feishu` skill (guides available in .claude/skills/)

---

## Key Concepts Summary

### Self-Registration
Channels register themselves via side-effect at module load:
```typescript
registerChannel('slack', (opts) => new SlackChannel(opts));
```

### Factory Pattern
Channels are instantiated on-demand via factory functions that check credentials:
```typescript
(opts: ChannelOpts) => Channel | null  // null if credentials missing
```

### Barrel File Loading
Single import point enables/disables all channels:
```typescript
import './slack.js';  // Triggers registerChannel() calls
```

### Callback-Based Messages
Channels push messages to core via callbacks:
```typescript
opts.onMessage(jid, NewMessage)  // Channel → Core
core.sendMessage(jid, text)       // Core → Channel
```

### Optional Capabilities
Advanced features are optional and detected at runtime:
```typescript
if (channel.setTyping) { await channel.setTyping(...); }
if (channel.reactToMessage) { await channel.reactToMessage(...); }
```

---

## File Structure

```
src/channels/
├─ registry.ts          (29 lines) ← Factory pattern, global Map
├─ index.ts             (17 lines) ← Barrel file, imports channels
├─ slack.ts             (410 lines) ← SlackChannel implementation
├─ feishu.ts            (526 lines) ← FeishuChannel implementation
└─ slack.test.ts        (tests)

src/
├─ types.ts             (116 lines) ← Channel interface
└─ ... (core orchestrator)

.claude/skills/
└─ add-slack/
    └─ SKILL.md         (208 lines) ← Interactive setup guide
```

---

## Quick Reference

### The Channel Interface
```typescript
interface Channel {
  // Required (5 methods)
  name: string;
  connect(): Promise<void>;
  sendMessage(jid, text): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid): boolean;
  disconnect(): Promise<void>;
  
  // Optional (3 methods)
  setTyping?(jid, isTyping): Promise<void>;
  reactToMessage?(jid, msgId, emoji): Promise<void>;
  syncGroups?(force): Promise<void>;
}
```

### NewMessage Type
```typescript
{
  id: string;              // Platform message ID
  chat_jid: string;        // "slack:C123" or "feishu:oc_xxx"
  sender: string;          // Platform user ID
  sender_name: string;     // Human name (required!)
  content: string;         // Text (mentions translated)
  timestamp: string;       // ISO 8601
  is_from_me: boolean;     // Bot's own message?
}
```

### JID Format
```
slack:C0123456789      ← Slack channel ID
feishu:oc_xxx          ← Feishu chat ID
whatsapp:1234567890    ← WhatsApp phone number
telegram:123456789     ← Telegram chat ID
```

---

## Key Patterns

### 1. Self-Registration (in channel module)
```typescript
registerChannel('slack', (opts) => {
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!env.SLACK_BOT_TOKEN) return null;
  return new SlackChannel(opts);
});
```

### 2. Message Queuing
```typescript
async sendMessage(jid, text) {
  if (!this.connected) {
    this.outgoingQueue.push({ jid, text });
    return;
  }
  // ... send via API
}

async connect() {
  await this.wsClient.start(...);
  this.connected = true;
  await this.flushOutgoingQueue();  // Retry queued messages
}
```

### 3. Mention Translation (Slack)
```typescript
if (content.includes(`<@${botUserId}>`)) {
  content = `@${ASSISTANT_NAME} ${content}`;
}
```

### 4. File Reference Extraction
```typescript
const imgPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
let cleanText = text.replace(imgPattern, (_, path) => {
  const hostPath = this.resolveContainerPath(jid, path);
  if (hostPath) filePaths.push(hostPath);
  return '';
});
```

### 5. Bot Message Detection
```typescript
const isBotMessage = msg.bot_id || msg.user === botUserId;
if (isBotMessage) return;  // Don't echo ourselves
```

---

## Slack vs Feishu Comparison

| Aspect | Slack | Feishu |
|--------|-------|--------|
| **Connection Type** | Socket Mode (WebSocket) | WebSocket via SDK |
| **Registration** | Manual pre-register | Auto on first message |
| **Credentials** | BOT_TOKEN, APP_TOKEN | APP_ID, APP_SECRET |
| **Message Format** | Plain text | JSON: `{text: "..."}` |
| **Typing Indicator** | No API (faked) | No |
| **Reactions** | Not exposed | ✓ Yes |
| **File Upload** | Single filesUploadV2() | image.create() + file.create() |
| **Mention Format** | `<@BOTID>` | `<at user_id="...">name</at>` |
| **Deduplication** | Not needed (WebSocket) | Yes (3s re-push) |
| **Metadata Sync** | Proactive (startup) | On-demand (per chat) |
| **Thread Support** | Flattened (limitation) | Basic support |

---

## Adding a New Channel: Checklist

```
Code Implementation:
  ☐ Create src/channels/myplatform.ts
  ☐ Implement Channel interface
  ☐ Read credentials via readEnvFile()
  ☐ Call registerChannel('myplatform', factory)
  ☐ Add import to src/channels/index.ts
  ☐ Parse platform events → NewMessage
  ☐ Translate mentions to @ASSISTANT_NAME
  ☐ Implement message queuing
  ☐ Extract & upload file references
  ☐ Run tests: npm build + vitest

Skill Setup:
  ☐ Create .claude/skills/add-myplatform/SKILL.md
  ☐ Phase 1: Pre-flight (check credentials)
  ☐ Phase 2: Merge skill branch
  ☐ Phase 3: User creates bot/app
  ☐ Phase 4: Register channels
  ☐ Phase 5: Verify bot responds

Documentation:
  ☐ SKILL.md < 500 lines
  ☐ Troubleshooting section
  ☐ Known limitations
  ☐ JID format explained
```

---

## Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| Bot doesn't respond | Mentions not translated | Check TRIGGER_PATTERN matches |
| Bot echoes itself | `is_from_me` not set | Bot message detection broken |
| Sender names are empty | Not resolving user IDs | Call platform user info API |
| Messages sent before connect() lost | No queuing | Implement outgoingQueue |
| Secrets leak to child processes | Using `process.env` | Use `readEnvFile()` instead |
| Unregistered groups trigger agent | No registration check | Add `if (!groups[jid]) return` |

---

## Source Files

- `src/types.ts` - Core interfaces (Channel, NewMessage, callbacks)
- `src/channels/registry.ts` - Factory pattern & self-registration
- `src/channels/index.ts` - Barrel file (channel loading)
- `src/channels/slack.ts` - Slack implementation (410 lines)
- `src/channels/feishu.ts` - Feishu implementation (526 lines)
- `CONTRIBUTING.md` - Skill guidelines & PR requirements
- `.claude/skills/add-slack/SKILL.md` - Interactive setup pattern

---

## Next Steps

1. **Quick Learn** → Read [CHANNEL_QUICK_START.md](CHANNEL_QUICK_START.md)
2. **Deep Dive** → Read [nanoclaw_channel_system.md](nanoclaw_channel_system.md)
3. **Reference** → Bookmark [channel_architecture_summary.md](channel_architecture_summary.md)
4. **Implement** → Use checklist + code patterns from docs
5. **Test** → Follow testing guide in Quick Start

---

**Last Updated**: 2026-04-20  
**Exploration Thoroughness**: Medium  
**Files Explored**: 7  
**Total Documentation**: ~65KB
