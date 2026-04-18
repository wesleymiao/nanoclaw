import * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { GROUPS_DIR } from '../config.js';
import { updateChatName, setRegisteredGroup, getAllRegisteredGroups } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Feishu message content limit (~30KB), but we split at a reasonable text length
const MAX_MESSAGE_LENGTH = 4000;

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client;
  private wsClient: lark.WSClient;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  /** Track processed message IDs to deduplicate (Feishu re-pushes within 3s) */
  private processedMessages = new Set<string>();
  /** Track "working on it" message IDs per chat for deletion */
  private workingMessageId = new Map<string, string>();
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

    this.client = new lark.Client({
      appId,
      appSecret,
    });

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

  private async resolveChatName(chatId: string): Promise<string | null> {
    try {
      const resp = await this.client.im.chat.get({ path: { chat_id: chatId } });
      return (resp as any)?.data?.name || null;
    } catch (err) {
      logger.warn({ chatId, err }, 'Feishu: failed to resolve chat name');
      return null;
    }
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
    // Feishu create_time is in milliseconds (13 digits) — no need to multiply
    const rawTime = parseInt(message.create_time, 10);
    const timestamp = new Date(
      rawTime > 1e12 ? rawTime : rawTime * 1000,
    ).toISOString();
    const chatType = message.chat_type; // 'p2p' or 'group'
    const isGroup = chatType === 'group';

    // Report metadata for discovery
    this.opts.onChatMetadata(jid, timestamp, undefined, 'feishu', isGroup);

    // Auto-register unregistered Feishu chats
    let groups = this.opts.registeredGroups();
    if (!groups[jid]) {
      const chatName = await this.resolveChatName(chatId) || chatId;
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

      // Create group folder with CLAUDE.md from feishu_main template or default
      const groupDir = path.join(GROUPS_DIR, folder);
      fs.mkdirSync(groupDir, { recursive: true });
      const mainTemplate = path.join(GROUPS_DIR, 'feishu_main', 'CLAUDE.md');
      const defaultTemplate = path.join(GROUPS_DIR, 'main', 'CLAUDE.md');
      const template = fs.existsSync(mainTemplate) ? mainTemplate :
                        fs.existsSync(defaultTemplate) ? defaultTemplate : null;
      if (template) {
        fs.copyFileSync(template, path.join(groupDir, 'CLAUDE.md'));
      }

      // Refresh registered groups so this message gets processed
      // Re-read from DB to pick up the new registration
      const freshGroups = getAllRegisteredGroups();
      // Update via the opts callback's underlying reference
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
      // For non-text messages, note the type
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
      // Use sender_id directly — contact API requires extra permissions
      senderName = sender?.sender_id?.open_id || 'unknown';
    }

    // Translate @mentions to trigger pattern
    // Feishu @mentions appear as <at user_id="...">name</at> in text
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

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^feishu:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Feishu disconnected, message queued',
      );
      return;
    }

    try {
      // Extract file references and upload them natively
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

      // Upload files
      for (const filePath of filePaths) {
        try {
          await this.uploadFile(chatId, filePath);
          logger.info({ jid, filename: path.basename(filePath) }, 'Feishu file uploaded');
        } catch (fileErr) {
          logger.warn({ jid, filePath, err: fileErr }, 'Failed to upload file to Feishu');
          // Fall back to text
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

      logger.info(
        { jid, length: text.length, fileCount: filePaths.length },
        'Feishu message sent',
      );
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Feishu message, queued',
      );
    }
  }

  private async uploadFile(chatId: string, filePath: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext);

    if (isImage) {
      // Upload as image
      const resp = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: fs.readFileSync(filePath),
        },
      });
      const imageKey = (resp as any)?.data?.image_key;
      if (imageKey) {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'image',
            content: JSON.stringify({ image_key: imageKey }),
          },
        });
      }
    } else {
      // Upload as file
      const resp = await this.client.im.file.create({
        data: {
          file_type: this.getFeishuFileType(ext),
          file_name: path.basename(filePath),
          file: fs.readFileSync(filePath),
        },
      });
      const fileKey = (resp as any)?.data?.file_key;
      if (fileKey) {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
        });
      }
    }
  }

  private getFeishuFileType(ext: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
    const map: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
      '.pdf': 'pdf',
      '.doc': 'doc',
      '.docx': 'doc',
      '.xls': 'xls',
      '.xlsx': 'xls',
      '.ppt': 'ppt',
      '.pptx': 'ppt',
      '.mp4': 'mp4',
      '.mp3': 'mp4',
    };
    return map[ext] || 'stream';
  }

  private splitText(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
    }
    return chunks;
  }

  /**
   * Resolve a container path to host path using group folder.
   */
  private resolveContainerPath(
    jid: string,
    containerPath: string,
  ): string | null {
    const groups = this.opts.registeredGroups();
    const group = groups[jid];
    if (!group) return null;

    const relative = containerPath.replace(/^\/workspace\/group\//, '');
    if (relative === containerPath) return null;
    const hostPath = path.join(GROUPS_DIR, group.folder, relative);
    return fs.existsSync(hostPath) ? hostPath : null;
  }

  /**
   * Extract markdown image references from text.
   */
  private extractFileReferences(
    jid: string,
    text: string,
  ): { cleanText: string; filePaths: string[] } {
    const filePaths: string[] = [];
    const imgPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
    let cleanText = text.replace(imgPattern, (_match, filePath: string) => {
      const hostPath = this.resolveContainerPath(jid, filePath.trim());
      if (hostPath) {
        filePaths.push(hostPath);
        return '';
      }
      return _match;
    });
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();
    return { cleanText, filePaths };
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    // WSClient doesn't have a stop method in all SDK versions
    // Setting connected=false prevents further message processing
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const chatId = jid.replace(/^feishu:/, '');
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: '⏳ Working on it…' }),
        },
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Feishu setTyping error (non-fatal)');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Feishu outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const chatId = item.jid.replace(/^feishu:/, '');
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: item.text }),
          },
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Feishu message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
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
