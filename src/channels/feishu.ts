import * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { GROUPS_DIR } from '../config.js';
import {
  updateChatName,
  setRegisteredGroup,
  getAllRegisteredGroups,
} from '../db.js';
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

type PostTag =
  | { tag: 'text'; text: string; style?: string[] }
  | { tag: 'a'; text: string; href: string; style?: string[] }
  | { tag: 'code_block'; language: string; text: string };

/**
 * Check if text contains markdown formatting worth converting to rich text.
 */
function hasMarkdown(text: string): boolean {
  return /\*\*.+?\*\*|__.+?__|`.+?`|\[.+?\]\(.+?\)|^#{1,6}\s|```/m.test(text);
}

/**
 * Parse a single line of markdown into an array of Feishu post tags.
 * Handles: **bold**, *italic*, `code`, [link](url)
 */
function parseInlineTags(line: string): PostTag[] {
  const tags: PostTag[] = [];
  const re = /(\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_([^_]+?)_|`([^`]+?)`|\[([^\]]+?)\]\(([^)]+?)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tags.push({ tag: 'text', text: line.slice(lastIndex, match.index) });
    }

    if (match[2] || match[3]) {
      // **bold** or __bold__
      tags.push({ tag: 'text', text: match[2] || match[3], style: ['bold'] });
    } else if (match[4] || match[5]) {
      // *italic* or _italic_
      tags.push({ tag: 'text', text: match[4] || match[5], style: ['italic'] });
    } else if (match[6]) {
      // `code` — render as bold for inline code (Feishu has no inline code tag)
      tags.push({ tag: 'text', text: match[6], style: ['bold'] });
    } else if (match[7] && match[8]) {
      // [text](url)
      tags.push({ tag: 'a', text: match[7], href: match[8] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    tags.push({ tag: 'text', text: line.slice(lastIndex) });
  }

  if (tags.length === 0) {
    tags.push({ tag: 'text', text: line });
  }

  return tags;
}

/**
 * Convert markdown text to Feishu post content structure.
 */
export function markdownToPost(text: string): { post: { zh_cn: { title: string; content: (PostTag | PostTag[])[][] } } } {
  const lines = text.split('\n');
  const paragraphs: PostTag[][] = [];
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];
  let codeBlockLang = '';

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        paragraphs.push([{ tag: 'code_block', language: codeBlockLang || 'PLAIN', text: codeBlockLines.join('\n') }]);
        codeBlockLines = [];
        codeBlockLang = '';
        inCodeBlock = false;
      } else {
        codeBlockLang = line.trimStart().slice(3).trim();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (!line.trim()) continue;

    // Heading → bold text
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      if (level <= 2) {
        // H1/H2: bold with underline decoration
        paragraphs.push([{ tag: 'text', text: `━━ ${text} ━━`, style: ['bold'] }]);
      } else if (level === 3) {
        // H3: bold with bullet prefix
        paragraphs.push([{ tag: 'text', text: `▎${text}`, style: ['bold'] }]);
      } else {
        // H4+: bold only
        paragraphs.push([{ tag: 'text', text, style: ['bold'] }]);
      }
      continue;
    }

    // Bullet points
    const bulletMatch = line.match(/^(\s*[-*•]\s+)(.*)/);
    if (bulletMatch) {
      const tags = parseInlineTags(bulletMatch[2]);
      paragraphs.push([{ tag: 'text', text: '• ' }, ...tags]);
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\s*\d+\.\s+)(.*)/);
    if (numMatch) {
      const tags = parseInlineTags(numMatch[2]);
      paragraphs.push([{ tag: 'text', text: numMatch[1] }, ...tags]);
      continue;
    }

    // Blockquote
    const quoteMatch = line.match(/^>\s?(.*)/);
    if (quoteMatch) {
      const tags = parseInlineTags(quoteMatch[1]);
      paragraphs.push([{ tag: 'text', text: '❝ ' }, ...tags, { tag: 'text', text: ' ❞' }]);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      continue; // skip hr lines
    }

    paragraphs.push(parseInlineTags(line));
  }

  if (inCodeBlock && codeBlockLines.length > 0) {
    paragraphs.push([{ tag: 'code_block', language: codeBlockLang || 'PLAIN', text: codeBlockLines.join('\n') }]);
  }

  return {
    post: {
      zh_cn: {
        title: '',
        content: paragraphs,
      },
    },
  };
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
  /** Cache user open_id → display name */
  private userNameCache = new Map<string, string>();
  /** Text batching: Feishu clients split long messages at ~4096 chars.
   *  Buffer chunks from same sender in same chat and flush after a delay. */
  private textBatch = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      chunks: Array<{ data: any; content: string }>;
    }
  >();
  private opts: FeishuChannelOpts;
  private dispatcher: lark.EventDispatcher;

  constructor(opts: FeishuChannelOpts) {
    this.opts = opts;

    const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
    const appId = env.FEISHU_APP_ID;
    const appSecret = env.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error(
        'FEISHU_APP_ID and FEISHU_APP_SECRET must be set in .env',
      );
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
        logger.debug(
          { eventType: 'im.message.receive_v1' },
          'Feishu event received',
        );
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

  /**
   * Download an image from a Feishu message and save to the group's workspace.
   * Returns the container-relative path (/workspace/group/uploads/...) or null on failure.
   */
  private async downloadImage(
    jid: string,
    message: any,
  ): Promise<string | null> {
    try {
      let imageKey = '';
      try {
        const parsed = JSON.parse(message.content);
        imageKey = parsed.image_key || '';
      } catch {}
      if (!imageKey) return null;
      return this.downloadImageByKey(jid, message.message_id, imageKey);
    } catch (err) {
      logger.warn({ jid, err }, 'Feishu: failed to download image');
      return null;
    }
  }

  /**
   * Download a file from a Feishu message and save to the group's workspace.
   * Returns the container-relative path or null on failure.
   */
  private async downloadFile(
    jid: string,
    message: any,
  ): Promise<string | null> {
    try {
      const messageId = message.message_id;
      let fileKey = '';
      let fileName = 'file';
      try {
        const parsed = JSON.parse(message.content);
        fileKey = parsed.file_key || '';
        fileName = parsed.file_name || 'file';
      } catch {}
      if (!fileKey) return null;

      const groups = this.opts.registeredGroups();
      const group = groups[jid];
      if (!group) return null;

      const uploadsDir = path.join(GROUPS_DIR, group.folder, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      // Preserve original filename with timestamp prefix to avoid collisions
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `${Date.now()}-${safeName}`;
      const hostPath = path.join(uploadsDir, filename);

      const resp = await (this.client as any).im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

      if (typeof resp?.writeFile === 'function') {
        await resp.writeFile(hostPath);
      } else if (typeof resp?.getReadableStream === 'function') {
        const stream = resp.getReadableStream();
        await new Promise<void>((resolve, reject) => {
          const ws = fs.createWriteStream(hostPath);
          stream.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
        });
      } else {
        return null;
      }

      logger.info({ jid, messageId, filename }, 'Feishu file downloaded');
      return `/workspace/group/uploads/${filename}`;
    } catch (err) {
      logger.warn({ jid, err }, 'Feishu: failed to download file');
      return null;
    }
  }

  /**
   * Download a media file (video/audio) from a Feishu message.
   * Returns the container-relative path or null on failure.
   */
  private async downloadMedia(
    jid: string,
    message: any,
  ): Promise<string | null> {
    try {
      const messageId = message.message_id;
      let fileKey = '';
      let fileName = 'media';
      try {
        const parsed = JSON.parse(message.content);
        fileKey = parsed.file_key || '';
        fileName = parsed.file_name || parsed.name || 'media';
      } catch {}
      if (!fileKey) return null;

      const groups = this.opts.registeredGroups();
      const group = groups[jid];
      if (!group) return null;

      const uploadsDir = path.join(GROUPS_DIR, group.folder, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `${Date.now()}-${safeName}`;
      const hostPath = path.join(uploadsDir, filename);

      // Try 'file' type first, fallback to 'media' if it fails
      let resp: any = null;
      for (const resourceType of ['file', 'media']) {
        try {
          resp = await (this.client as any).im.messageResource.get({
            path: { message_id: messageId, file_key: fileKey },
            params: { type: resourceType },
          });
          if (resp?.writeFile || resp?.getReadableStream) break;
        } catch {
          resp = null;
        }
      }

      if (typeof resp?.writeFile === 'function') {
        await resp.writeFile(hostPath);
      } else if (typeof resp?.getReadableStream === 'function') {
        const stream = resp.getReadableStream();
        await new Promise<void>((resolve, reject) => {
          const ws = fs.createWriteStream(hostPath);
          stream.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
        });
      } else {
        return null;
      }

      logger.info({ jid, messageId, filename }, 'Feishu media downloaded');
      return `/workspace/group/uploads/${filename}`;
    } catch (err) {
      logger.warn({ jid, err }, 'Feishu: failed to download media');
      return null;
    }
  }

  /**
   * Download an image by message ID and image key, saving to group uploads dir.
   * Returns the container-relative path or null on failure.
   */
  private async downloadImageByKey(
    jid: string,
    messageId: string,
    imageKey: string,
  ): Promise<string | null> {
    try {
      const groups = this.opts.registeredGroups();
      const group = groups[jid];
      if (!group) return null;

      const uploadsDir = path.join(GROUPS_DIR, group.folder, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`;
      const hostPath = path.join(uploadsDir, filename);

      const resp = await (this.client as any).im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });

      if (typeof resp?.writeFile === 'function') {
        await resp.writeFile(hostPath);
      } else if (typeof resp?.getReadableStream === 'function') {
        const stream = resp.getReadableStream();
        await new Promise<void>((resolve, reject) => {
          const ws = fs.createWriteStream(hostPath);
          stream.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
        });
      } else {
        return null;
      }

      logger.info(
        { jid, messageId, imageKey, filename },
        'Feishu image downloaded (post)',
      );
      return `/workspace/group/uploads/${filename}`;
    } catch (err) {
      logger.warn(
        { jid, imageKey, err },
        'Feishu: failed to download post image',
      );
      return null;
    }
  }

  /**
   * Parse a Feishu "post" (rich text) message.
   * Structure: {"title":"...", "content":[[{"tag":"text","text":"hello"},{"tag":"img","image_key":"img_xxx"}]]}
   * Returns combined text with image paths for the agent.
   */
  private async parsePostMessage(jid: string, message: any): Promise<string> {
    try {
      const parsed = JSON.parse(message.content);
      logger.info(
        {
          jid,
          parsedKeys: Object.keys(parsed || {}),
          rawContent: message.content?.slice(0, 500),
        },
        'Feishu: parsePostMessage debug',
      );
      // Post content may be nested under a locale key (zh_cn, en_us) or directly at top level
      const post =
        parsed?.zh_cn ||
        parsed?.en_us ||
        parsed?.ja_jp ||
        (parsed?.content ? parsed : null) ||
        (Object.values(parsed || {})[0] as any);
      if (!post) {
        logger.warn(
          { jid, parsedKeys: Object.keys(parsed || {}) },
          'Feishu: post has no locale key',
        );
        return '[post message - could not parse]';
      }
      logger.info(
        {
          jid,
          title: post.title,
          contentLength: post.content?.length,
          postKeys: Object.keys(post || {}),
        },
        'Feishu: post structure',
      );

      const title = post.title || '';
      const contentBlocks: Array<Array<any>> = post.content || [];
      const parts: string[] = [];
      if (title) parts.push(title);

      const messageId = message.message_id;
      for (const line of contentBlocks) {
        if (!Array.isArray(line)) continue;
        for (const block of line) {
          if (block.tag === 'text') {
            parts.push(block.text || '');
          } else if (block.tag === 'a') {
            parts.push(
              block.text
                ? `${block.text} (${block.href || ''})`
                : block.href || '',
            );
          } else if (block.tag === 'img' && block.image_key) {
            const imgPath = await this.downloadImageByKey(
              jid,
              messageId,
              block.image_key,
            );
            if (imgPath) {
              parts.push(
                `[Image: ${imgPath}]\nUse the Read tool to view this image.`,
              );
            }
          }
        }
      }

      const result = parts.join('\n') || '[empty post message]';
      logger.info(
        { jid, resultLength: result.length, result: result.slice(0, 200) },
        'Feishu: parsePostMessage result',
      );
      return result;
    } catch (err) {
      logger.warn({ jid, err }, 'Feishu: failed to parse post message');
      return '[post message - parse error]';
    }
  }

  private async resolveUserName(openId: string): Promise<string | null> {
    const cached = this.userNameCache.get(openId);
    if (cached) return cached;
    try {
      const resp = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const name = (resp as any)?.data?.user?.name || null;
      if (name) this.userNameCache.set(openId, name);
      return name;
    } catch (err) {
      logger.warn({ openId, err }, 'Feishu: failed to resolve user name');
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
      const chatName = (await this.resolveChatName(chatId)) || chatId;
      const safeName =
        chatName
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
      const template = fs.existsSync(mainTemplate)
        ? mainTemplate
        : fs.existsSync(defaultTemplate)
          ? defaultTemplate
          : null;
      if (template) {
        fs.copyFileSync(template, path.join(groupDir, 'CLAUDE.md'));
      }

      // Refresh registered groups so this message gets processed
      // Re-read from DB to pick up the new registration
      const freshGroups = getAllRegisteredGroups();
      // Update via the opts callback's underlying reference
      Object.assign(groups, freshGroups);

      logger.info(
        { jid, name: chatName, folder },
        'Feishu: auto-registered new chat',
      );
    }

    // Parse message content — Feishu sends JSON strings
    let content = '';
    const msgType = message.message_type;
    logger.info(
      { jid, msgType, contentKeys: Object.keys(message).join(',') },
      'Feishu: incoming message type',
    );

    // Text messages may be split by Feishu client at ~4096 chars — batch them
    if (msgType === 'text') {
      try {
        const parsed = JSON.parse(message.content);
        content = parsed.text || '';
      } catch {
        content = message.content || '';
      }
      if (!content) return;

      const senderId =
        data.sender?.sender_id?.open_id ||
        data.sender?.sender_id?.user_id ||
        '';
      const batchKey = `${jid}:${senderId}`;
      const existing = this.textBatch.get(batchKey);

      if (existing) {
        clearTimeout(existing.timer);
        existing.chunks.push({ data, content });
      } else {
        this.textBatch.set(batchKey, {
          timer: setTimeout(() => {}, 0), // placeholder
          chunks: [{ data, content }],
        });
      }

      const batch = this.textBatch.get(batchKey)!;
      // If message is near the split threshold, wait longer for continuation
      const SPLIT_THRESHOLD = 3800;
      const delay = content.length >= SPLIT_THRESHOLD ? 2000 : 600;

      batch.timer = setTimeout(() => {
        this.textBatch.delete(batchKey);
        const combined = batch.chunks.map((c) => c.content).join('');
        const lastChunk = batch.chunks[batch.chunks.length - 1];
        logger.info(
          { jid, chunks: batch.chunks.length, totalLength: combined.length },
          'Feishu: text batch flushed',
        );
        this.emitMessage(
          jid,
          lastChunk.data,
          combined,
          message.message_id,
        ).catch((err) =>
          logger.error({ jid, err }, 'Feishu: emitMessage error'),
        );
      }, delay);
      return;
    }

    if (msgType === 'image') {
      // Download image and save to group workspace for agent to Read
      const imagePath = await this.downloadImage(jid, message);
      if (imagePath) {
        content = `[User sent an image: ${imagePath}]\nUse the Read tool to view this image.`;
      } else {
        content = '[image message - failed to download]';
      }
    } else if (msgType === 'file') {
      // Download file and save to group workspace
      const filePath = await this.downloadFile(jid, message);
      if (filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.docx' || ext === '.doc') {
          content = `[User sent a Word document: ${filePath}]\nUse mammoth to extract text: npx mammoth ${filePath} --output-format=markdown\nOr read it with: npx mammoth ${filePath} /dev/stdout 2>/dev/null`;
        } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
          content = `[User sent a spreadsheet: ${filePath}]\nUse the xlsx package to read it:\nnode -e "const XLSX = require('xlsx'); const wb = XLSX.readFile('${filePath}'); wb.SheetNames.forEach(n => { console.log('=== ' + n + ' ==='); console.log(XLSX.utils.sheet_to_csv(wb.Sheets[n])); });"`;
        } else if (ext === '.pdf') {
          content = `[User sent a PDF: ${filePath}]\nUse the Read tool to view this PDF.`;
        } else {
          content = `[User sent a file: ${filePath}]`;
        }
      } else {
        content = '[file message - failed to download]';
      }
    } else if (msgType === 'post') {
      // Rich text: extract text and images from post content
      content = await this.parsePostMessage(jid, message);
    } else if (msgType === 'media' || msgType === 'audio') {
      // Video/audio — download via file API
      const filePath = await this.downloadMedia(jid, message);
      if (filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
          content = `[User sent a video: ${filePath}]\nUse ffmpeg to process it. Examples:\n- Extract audio: ffmpeg -i ${filePath} -vn /tmp/audio.mp3\n- Remove audio: ffmpeg -i ${filePath} -an -c:v copy /tmp/silent.mp4\n- Get info: ffprobe ${filePath}`;
        } else {
          content = `[User sent an audio file: ${filePath}]\nUse ffmpeg to process it. Example: ffprobe ${filePath}`;
        }
      } else {
        content = `[${msgType} message - failed to download]`;
      }
    } else {
      // For non-text messages, note the type
      content = `[${msgType} message]`;
    }

    if (!content) return;

    this.emitMessage(jid, data, content, message.message_id);
  }

  /** Emit a parsed message to the pipeline (sender resolution + trigger translation) */
  private async emitMessage(
    jid: string,
    data: any,
    content: string,
    messageId: string,
  ): Promise<void> {
    const message = data?.message;
    const rawTime = parseInt(message?.create_time, 10);
    const timestamp = new Date(
      rawTime > 1e12 ? rawTime : rawTime * 1000,
    ).toISOString();

    // Get sender info
    const sender = data.sender;
    const senderId =
      sender?.sender_id?.open_id || sender?.sender_id?.user_id || '';
    const senderType = sender?.sender_type || '';
    const isBotMessage = senderType === 'app';

    let senderName: string;
    if (isBotMessage) {
      senderName = ASSISTANT_NAME;
    } else {
      // Resolve display name from Feishu contact API
      senderName = (await this.resolveUserName(senderId)) || senderId;
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

  async sendMessage(jid: string, text: string): Promise<string | undefined> {
    const chatId = jid.replace(/^feishu:/, '');
    let firstMessageId: string | undefined;

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
        const isVerbose = cleanText.startsWith('▎');
        if (!isVerbose && hasMarkdown(cleanText)) {
          // Try interactive card (JSON 2.0) for native markdown rendering (headings, tables, etc.)
          // Fall back to post format, then plain text
          try {
            const cardContent = JSON.stringify({
              schema: '2.0',
              body: {
                elements: [{ tag: 'markdown', content: cleanText }],
              },
            });
            const resp = await this.client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'interactive',
                content: cardContent,
              },
            });
            if (!firstMessageId && resp?.data?.message_id) {
              firstMessageId = resp.data.message_id;
            }
          } catch (cardErr) {
            logger.warn({ chatId, err: cardErr }, 'Feishu card message failed, falling back to post format');
            try {
              const postContent = markdownToPost(cleanText);
              const resp = await this.client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                  receive_id: chatId,
                  msg_type: 'post',
                  content: JSON.stringify({
                    zh_cn: postContent.post.zh_cn,
                  }),
                },
              });
              if (!firstMessageId && resp?.data?.message_id) {
                firstMessageId = resp.data.message_id;
              }
            } catch (postErr) {
              logger.warn({ chatId, err: postErr }, 'Feishu post message failed, falling back to plain text');
              const chunks = this.splitText(cleanText);
              for (const chunk of chunks) {
                const resp = await this.client.im.message.create({
                  params: { receive_id_type: 'chat_id' },
                  data: {
                    receive_id: chatId,
                    msg_type: 'text',
                    content: JSON.stringify({ text: chunk }),
                  },
                });
                if (!firstMessageId && resp?.data?.message_id) {
                  firstMessageId = resp.data.message_id;
                }
              }
            }
          }
        } else {
          // Plain text — send as-is
          const chunks = this.splitText(cleanText);
          for (const chunk of chunks) {
            const resp = await this.client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: chunk }),
              },
            });
            if (!firstMessageId && resp?.data?.message_id) {
              firstMessageId = resp.data.message_id;
            }
          }
        }
      }

      // Upload files
      for (const filePath of filePaths) {
        try {
          await this.uploadFile(chatId, filePath);
          logger.info(
            { jid, filename: path.basename(filePath) },
            'Feishu file uploaded',
          );
        } catch (fileErr) {
          logger.warn(
            { jid, filePath, err: fileErr },
            'Failed to upload file to Feishu',
          );
          // Fall back to text
          await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({
                text: `📎 File: ${path.basename(filePath)}`,
              }),
            },
          });
        }
      }

      logger.info(
        { jid, length: text.length, fileCount: filePaths.length },
        'Feishu message sent',
      );
      return firstMessageId;
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
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(
      ext,
    );

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

  private getFeishuFileType(
    ext: string,
  ): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
    const map: Record<
      string,
      'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'
    > = {
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
    // No-op — we use reactToMessage instead
  }

  async reactToMessage(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    try {
      await (this.client as any).im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Feishu reactToMessage error',
      );
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
