import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';

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

const MAX_MESSAGE_LENGTH = 2048;
const TOKEN_REFRESH_MARGIN = 200; // refresh 200s before expiry

export interface WeComChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WeComChannel implements Channel {
  name = 'wecom';

  private corpId: string;
  private corpSecret: string;
  private agentId: string;
  private callbackToken: string;
  private encodingAesKey: Buffer;
  private callbackPort: number;
  private connected = false;
  private server: http.Server | null = null;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private processedMessages = new Set<string>();
  private userNameCache = new Map<string, string>();
  private textBatch = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      chunks: Array<{
        fromUser: string;
        content: string;
        msgId: string;
        createTime: number;
      }>;
    }
  >();
  private opts: WeComChannelOpts;
  private xmlParser: XMLParser;

  // Access token cache
  private accessToken = '';
  private tokenExpiresAt = 0;

  constructor(opts: WeComChannelOpts) {
    this.opts = opts;

    const env = readEnvFile([
      'WECOM_CORP_ID',
      'WECOM_CORP_SECRET',
      'WECOM_AGENT_ID',
      'WECOM_TOKEN',
      'WECOM_ENCODING_AES_KEY',
      'WECOM_CALLBACK_PORT',
    ]);

    this.corpId = env.WECOM_CORP_ID || '';
    this.corpSecret = env.WECOM_CORP_SECRET || '';
    this.agentId = env.WECOM_AGENT_ID || '';
    this.callbackToken = env.WECOM_TOKEN || '';
    this.callbackPort = parseInt(env.WECOM_CALLBACK_PORT || '9800', 10);

    const aesKeyB64 = (env.WECOM_ENCODING_AES_KEY || '') + '=';
    this.encodingAesKey = Buffer.from(aesKeyB64, 'base64');

    if (!this.corpId || !this.corpSecret) {
      throw new Error(
        'WECOM_CORP_ID and WECOM_CORP_SECRET must be set in .env',
      );
    }

    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
    });
  }

  // ── Access Token ──────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.accessToken && now < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN) {
      return this.accessToken;
    }

    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.corpSecret)}`;
    const resp = await fetch(url);
    const data = (await resp.json()) as any;

    if (data.errcode !== 0) {
      throw new Error(`WeCom gettoken failed: ${data.errmsg}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + (data.expires_in || 7200);
    logger.info('WeCom: access token refreshed');
    return this.accessToken;
  }

  // ── Crypto ────────────────────────────────────────────────────

  private verifySignature(
    token: string,
    timestamp: string,
    nonce: string,
    encrypt: string,
  ): string {
    const arr = [token, timestamp, nonce, encrypt].sort();
    return crypto.createHash('sha1').update(arr.join('')).digest('hex');
  }

  private decrypt(encrypted: string): { message: string; receiveid: string } {
    const buf = Buffer.from(encrypted, 'base64');
    const iv = this.encodingAesKey.subarray(0, 16);
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      this.encodingAesKey,
      iv,
    );
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(buf), decipher.final()]);

    // Remove PKCS#7 padding
    const padLen = decrypted[decrypted.length - 1];
    const content = decrypted.subarray(0, decrypted.length - padLen);

    // Skip 16 bytes random, read 4 bytes msg_len (network byte order)
    const msgLen = content.readUInt32BE(16);
    const message = content.subarray(20, 20 + msgLen).toString('utf8');
    const receiveid = content.subarray(20 + msgLen).toString('utf8');

    return { message, receiveid };
  }

  private encrypt(text: string): string {
    const random = crypto.randomBytes(16);
    const msgBuf = Buffer.from(text, 'utf8');
    const msgLen = Buffer.alloc(4);
    msgLen.writeUInt32BE(msgBuf.length, 0);
    const receiveidBuf = Buffer.from(this.corpId, 'utf8');

    const plaintext = Buffer.concat([random, msgLen, msgBuf, receiveidBuf]);

    // Add PKCS#7 padding
    const blockSize = 32;
    const padLen = blockSize - (plaintext.length % blockSize);
    const padding = Buffer.alloc(padLen, padLen);
    const padded = Buffer.concat([plaintext, padding]);

    const iv = this.encodingAesKey.subarray(0, 16);
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      this.encodingAesKey,
      iv,
    );
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    return encrypted.toString('base64');
  }

  // ── HTTP Callback Server ──────────────────────────────────────

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'WeCom: callback handler error');
        res.writeHead(500);
        res.end('Internal Server Error');
      });
    });

    return new Promise<void>((resolve) => {
      this.server!.listen(this.callbackPort, () => {
        this.connected = true;
        logger.info(
          { port: this.callbackPort },
          'WeCom: callback server listening',
        );
        resolve();
      });
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const urlObj = new URL(req.url || '/', `http://localhost`);

    if (!urlObj.pathname.startsWith('/wecom/callback')) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const msgSignature = urlObj.searchParams.get('msg_signature') || '';
    const timestamp = urlObj.searchParams.get('timestamp') || '';
    const nonce = urlObj.searchParams.get('nonce') || '';

    if (req.method === 'GET') {
      // URL verification
      const echostr = urlObj.searchParams.get('echostr') || '';
      const sig = this.verifySignature(
        this.callbackToken,
        timestamp,
        nonce,
        echostr,
      );

      if (sig !== msgSignature) {
        logger.warn('WeCom: URL verification signature mismatch');
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const { message } = this.decrypt(echostr);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(message);
      logger.info('WeCom: URL verification succeeded');
      return;
    }

    if (req.method === 'POST') {
      // Receive message
      const body = await this.readBody(req);
      const parsed = this.xmlParser.parse(body);
      const xml = parsed?.xml || parsed;

      const encrypt = xml?.Encrypt || '';
      const sig = this.verifySignature(
        this.callbackToken,
        timestamp,
        nonce,
        encrypt,
      );

      if (sig !== msgSignature) {
        logger.warn('WeCom: message signature mismatch');
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // Respond immediately — WeCom expects response within 5s
      res.writeHead(200);
      res.end('success');

      try {
        const { message: decryptedXml } = this.decrypt(encrypt);
        const msgData = this.xmlParser.parse(decryptedXml);
        const msg = msgData?.xml || msgData;
        await this.handleMessage(msg);
      } catch (err) {
        logger.error({ err }, 'WeCom: message processing error');
      }
      return;
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // ── Inbound Message Handling ──────────────────────────────────

  private async handleMessage(msg: any): Promise<void> {
    const msgType = msg.MsgType;

    // Skip non-message events (e.g. event type callbacks)
    if (!msgType || msgType === 'event') {
      logger.debug({ msgType, event: msg.Event }, 'WeCom: skipping event');
      return;
    }

    const msgId = String(msg.MsgId || `${msg.FromUserName}-${msg.CreateTime}`);

    // Deduplicate
    if (this.processedMessages.has(msgId)) return;
    this.processedMessages.add(msgId);
    if (this.processedMessages.size > 1000) {
      const ids = [...this.processedMessages];
      for (let i = 0; i < ids.length - 500; i++) {
        this.processedMessages.delete(ids[i]);
      }
    }

    const fromUser = String(msg.FromUserName || '');
    const toUser = String(msg.ToUserName || '');
    const createTime = parseInt(msg.CreateTime, 10) || 0;
    const timestamp = new Date(createTime * 1000).toISOString();

    // Determine JID — for DMs use user ID, for group chats use group chatid
    // WeCom sends AgentID for app messages; FromUserName is always the user's userid
    const agentId = String(msg.AgentID || this.agentId);
    const jid = `wecom:${agentId}`;

    // Report metadata
    this.opts.onChatMetadata(jid, timestamp, undefined, 'wecom', false);

    // Auto-register
    let groups = this.opts.registeredGroups();
    if (!groups[jid]) {
      const appName = `wecom-app-${agentId}`;
      const folder = `wecom_${appName}`;

      const group: RegisteredGroup = {
        name: appName,
        folder,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      };

      setRegisteredGroup(jid, group);

      const groupDir = path.join(GROUPS_DIR, folder);
      fs.mkdirSync(groupDir, { recursive: true });

      // Copy template CLAUDE.md if available
      const mainTemplate = path.join(GROUPS_DIR, 'wecom_main', 'CLAUDE.md');
      const defaultTemplate = path.join(GROUPS_DIR, 'main', 'CLAUDE.md');
      const template = fs.existsSync(mainTemplate)
        ? mainTemplate
        : fs.existsSync(defaultTemplate)
          ? defaultTemplate
          : null;
      if (template) {
        fs.copyFileSync(template, path.join(groupDir, 'CLAUDE.md'));
      }

      const freshGroups = getAllRegisteredGroups();
      Object.assign(groups, freshGroups);

      logger.info({ jid, folder }, 'WeCom: auto-registered new app chat');
    }

    let content = '';

    if (msgType === 'text') {
      content = String(msg.Content || '');
      if (!content) return;

      // Text batching (same pattern as Feishu)
      const batchKey = `${jid}:${fromUser}`;
      const existing = this.textBatch.get(batchKey);

      if (existing) {
        clearTimeout(existing.timer);
        existing.chunks.push({ fromUser, content, msgId, createTime });
      } else {
        this.textBatch.set(batchKey, {
          timer: setTimeout(() => {}, 0),
          chunks: [{ fromUser, content, msgId, createTime }],
        });
      }

      const batch = this.textBatch.get(batchKey)!;
      const SPLIT_THRESHOLD = 1800;
      const delay = content.length >= SPLIT_THRESHOLD ? 2000 : 600;

      batch.timer = setTimeout(() => {
        this.textBatch.delete(batchKey);
        const combined = batch.chunks.map((c) => c.content).join('');
        const lastChunk = batch.chunks[batch.chunks.length - 1];
        logger.info(
          { jid, chunks: batch.chunks.length, totalLength: combined.length },
          'WeCom: text batch flushed',
        );
        this.emitMessage(
          jid,
          lastChunk.fromUser,
          combined,
          lastChunk.msgId,
          lastChunk.createTime,
        ).catch((err) =>
          logger.error({ jid, err }, 'WeCom: emitMessage error'),
        );
      }, delay);
      return;
    }

    if (msgType === 'image') {
      const picUrl = msg.PicUrl || '';
      const mediaId = msg.MediaId || '';
      const imagePath = await this.downloadMedia(
        jid,
        mediaId,
        'image',
        'image.png',
      );
      if (imagePath) {
        content = `[User sent an image: ${imagePath}]\nUse the Read tool to view this image.`;
      } else if (picUrl) {
        content = `[User sent an image: ${picUrl}]`;
      } else {
        content = '[image message - failed to download]';
      }
    } else if (msgType === 'voice') {
      const mediaId = msg.MediaId || '';
      const filePath = await this.downloadMedia(
        jid,
        mediaId,
        'voice',
        'voice.amr',
      );
      if (filePath) {
        content = `[User sent a voice message: ${filePath}]\nUse ffmpeg to convert: ffmpeg -i ${filePath} /tmp/voice.mp3`;
      } else {
        content = '[voice message - failed to download]';
      }
    } else if (msgType === 'video') {
      const mediaId = msg.MediaId || '';
      const filePath = await this.downloadMedia(
        jid,
        mediaId,
        'video',
        'video.mp4',
      );
      if (filePath) {
        content = `[User sent a video: ${filePath}]\nUse ffmpeg to process: ffprobe ${filePath}`;
      } else {
        content = '[video message - failed to download]';
      }
    } else if (msgType === 'location') {
      const lat = msg.Location_X || '';
      const lng = msg.Location_Y || '';
      const label = msg.Label || '';
      content = `[Location: ${label} (${lat}, ${lng})]`;
    } else if (msgType === 'link') {
      const title = msg.Title || '';
      const desc = msg.Description || '';
      const url = msg.Url || '';
      content = `${title}\n${desc}\n${url}`.trim();
    } else {
      content = `[${msgType} message]`;
    }

    if (!content) return;

    await this.emitMessage(jid, fromUser, content, msgId, createTime);
  }

  private async emitMessage(
    jid: string,
    fromUser: string,
    content: string,
    msgId: string,
    createTime: number,
  ): Promise<void> {
    const timestamp = new Date(createTime * 1000).toISOString();

    // Resolve user name
    let senderName = (await this.resolveUserName(fromUser)) || fromUser;

    // Translate @mentions to trigger pattern
    if (TRIGGER_PATTERN && !TRIGGER_PATTERN.test(content)) {
      // WeCom doesn't have structured mentions, but users may type @name
      // If any message arrives to the bot, treat it as addressed
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    this.opts.onMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender: fromUser,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  // ── User Name Resolution ──────────────────────────────────────

  private async resolveUserName(userId: string): Promise<string | null> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const token = await this.getAccessToken();
      const url = `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${encodeURIComponent(userId)}`;
      const resp = await fetch(url);
      const data = (await resp.json()) as any;
      const name = data.name || null;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.warn({ userId, err }, 'WeCom: failed to resolve user name');
      return null;
    }
  }

  // ── Media Download ────────────────────────────────────────────

  private async downloadMedia(
    jid: string,
    mediaId: string,
    type: string,
    defaultName: string,
  ): Promise<string | null> {
    if (!mediaId) return null;

    try {
      const token = await this.getAccessToken();
      const url = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`;
      const resp = await fetch(url);

      if (!resp.ok) return null;

      const groups = this.opts.registeredGroups();
      const group = groups[jid];
      if (!group) return null;

      const uploadsDir = path.join(GROUPS_DIR, group.folder, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      const filename = `${Date.now()}-${defaultName}`;
      const hostPath = path.join(uploadsDir, filename);

      const arrayBuf = await resp.arrayBuffer();
      fs.writeFileSync(hostPath, Buffer.from(arrayBuf));

      logger.info({ jid, mediaId, filename }, 'WeCom: media downloaded');
      return `/workspace/group/uploads/${filename}`;
    } catch (err) {
      logger.warn({ jid, mediaId, err }, 'WeCom: failed to download media');
      return null;
    }
  }

  // ── Outbound Messages ─────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<string | undefined> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'WeCom disconnected, message queued',
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
          await this.sendTextMessage(chunk);
        }
      }

      // Upload files
      for (const filePath of filePaths) {
        try {
          await this.uploadAndSendFile(filePath);
          logger.info(
            { jid, filename: path.basename(filePath) },
            'WeCom file uploaded',
          );
        } catch (fileErr) {
          logger.warn(
            { jid, filePath, err: fileErr },
            'Failed to upload file to WeCom',
          );
          await this.sendTextMessage(`📎 File: ${path.basename(filePath)}`);
        }
      }

      logger.info(
        { jid, length: text.length, fileCount: filePaths.length },
        'WeCom message sent',
      );
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send WeCom message, queued',
      );
    }
  }

  private async sendTextMessage(text: string): Promise<void> {
    const token = await this.getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    // Use markdown for formatted content, text for plain
    const hasFormatting = /[*_`#\[\]|]/.test(text);
    const payload = hasFormatting
      ? {
          touser: '@all',
          msgtype: 'markdown',
          agentid: parseInt(this.agentId, 10),
          markdown: { content: text },
        }
      : {
          touser: '@all',
          msgtype: 'text',
          agentid: parseInt(this.agentId, 10),
          text: { content: text },
        };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = (await resp.json()) as any;
    if (data.errcode !== 0) {
      throw new Error(`WeCom send failed: ${data.errmsg}`);
    }
  }

  private async uploadAndSendFile(filePath: string): Promise<void> {
    const token = await this.getAccessToken();
    const ext = path.extname(filePath).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(
      ext,
    );
    const mediaType = isImage ? 'image' : 'file';

    // Upload media
    const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=${mediaType}`;
    const fileContent = fs.readFileSync(filePath);
    const boundary = `----WebKitFormBoundary${crypto.randomBytes(8).toString('hex')}`;
    const fileName = path.basename(filePath);

    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="media"; filename="${fileName}"\r\n`,
      `Content-Type: application/octet-stream\r\n\r\n`,
    ];

    const bodyStart = Buffer.from(bodyParts.join(''));
    const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([bodyStart, fileContent, bodyEnd]);

    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });

    const uploadData = (await uploadResp.json()) as any;
    if (uploadData.errcode !== 0) {
      throw new Error(`WeCom upload failed: ${uploadData.errmsg}`);
    }

    const mediaId = uploadData.media_id;

    // Send media message
    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
    const payload = {
      touser: '@all',
      msgtype: mediaType,
      agentid: parseInt(this.agentId, 10),
      [mediaType]: { media_id: mediaId },
    };

    const sendResp = await fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const sendData = (await sendResp.json()) as any;
    if (sendData.errcode !== 0) {
      throw new Error(`WeCom send ${mediaType} failed: ${sendData.errmsg}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private splitText(text: string): string[] {
    if (Buffer.byteLength(text) <= MAX_MESSAGE_LENGTH) return [text];
    // Split by characters but respect byte limit
    const chunks: string[] = [];
    let current = '';
    for (const char of text) {
      if (Buffer.byteLength(current + char) > MAX_MESSAGE_LENGTH) {
        chunks.push(current);
        current = char;
      } else {
        current += char;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

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
    return jid.startsWith('wecom:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // No-op — WeCom doesn't support typing indicators
  }

  async reactToMessage(
    _jid: string,
    _messageId: string,
    _emoji: string,
  ): Promise<void> {
    // No-op — WeCom doesn't support reactions
  }
}

registerChannel('wecom', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['WECOM_CORP_ID', 'WECOM_CORP_SECRET']);
  if (!envVars.WECOM_CORP_ID || !envVars.WECOM_CORP_SECRET) {
    logger.warn('WeCom: WECOM_CORP_ID or WECOM_CORP_SECRET not set');
    return null;
  }
  return new WeComChannel(opts);
});
