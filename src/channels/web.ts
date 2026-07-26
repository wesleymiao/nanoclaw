import * as crypto from 'crypto';
import * as http from 'http';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { searchMessages } from '../db.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { WEB_UI_HTML } from './web-ui.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SESSION_COOKIE_NAME = 'nanoclaw_session';
const CONVERSATION_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface Session {
  username: string;
  expiresAt: number;
}

/**
 * Basic username/password Web channel — a stopgap login model for Stage 1
 * of the multi-VM rollout (see sections/rollout.html §3.2 Stage 1). This is
 * explicitly NOT the target design: the eventual multi-VM architecture
 * (walkthrough.html) replaces this with Microsoft Entra External ID behind
 * Azure Front Door. Credentials live in plaintext in `.env` (same trust
 * model as other channels' API secrets) purely so Stage 1 can validate the
 * queue-partitioning/routing changes with real scriptable traffic, without
 * waiting on the Entra ID integration that lands in a later stage.
 *
 * Runs entirely in-process (same Node process as every other channel) on
 * its own HTTP port — no separate service, no queue, no pub/sub yet. That
 * externalization is exactly what Stages 2-6 progressively add.
 *
 * jid convention: `web:<username>:<conversationId>` — each login can have
 * multiple independent conversations (own folder/session/transcript, full
 * isolation, same as any other registered group), addressed by a
 * user-chosen conversationId. parseGroupKey() only splits on the FIRST
 * colon, so this composite jid's `channel:rest` shape needs no special
 * casing in group-key.ts — `rest` is simply `<username>:<conversationId>`.
 */
export class WebChannel implements Channel {
  name = 'web';

  private users: Map<string, string>;
  private port: number;
  private server: http.Server | null = null;
  private connected = false;
  private sessions = new Map<string, Session>();
  /** SSE subscribers, keyed by username (one multiplexed stream per login, covering all of that user's conversations). */
  private streams = new Map<string, Set<http.ServerResponse>>();
  /** Messages buffered per-username while no SSE stream is connected. */
  private outgoingQueue = new Map<
    string,
    Array<{ jid: string; text: string }>
  >();
  private sentCounter = 0;
  private opts: WebChannelOpts;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;

    const env = readEnvFile(['WEB_USERS', 'WEB_PORT']);
    this.users = parseWebUsers(env.WEB_USERS || '');
    this.port = parseInt(env.WEB_PORT || '9900', 10);

    if (this.users.size === 0) {
      throw new Error(
        'WEB_USERS must be set in .env (format: user:pass,user2:pass2)',
      );
    }
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'Web channel: request handler error');
        if (!res.headersSent) res.writeHead(500);
        res.end('Internal Server Error');
      });
    });

    return new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, 'Web channel: listening');
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const set of this.streams.values()) {
      // Test-only fake subscribers (see _attachTestSubscriber) only
      // implement write(), not the full http.ServerResponse surface.
      for (const res of set) res.end?.();
    }
    this.streams.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async sendMessage(jid: string, text: string): Promise<string | undefined> {
    const username = usernameFromJid(jid);
    if (!username) return undefined;

    this.sentCounter += 1;
    const messageId = `web-sent-${this.sentCounter}`;

    const subscribers = this.streams.get(username);
    if (!subscribers || subscribers.size === 0) {
      const buffered = this.outgoingQueue.get(username) || [];
      buffered.push({ jid, text });
      this.outgoingQueue.set(username, buffered);
      logger.info(
        { jid, queueSize: buffered.length },
        'Web channel: no live stream, message queued',
      );
      return messageId;
    }

    this.pushEvent(username, { jid, text, messageId });
    return messageId;
  }

  /**
   * Validates and dispatches one inbound chat message: auto-registers the
   * conversation on demand, then delivers it via the same onMessage()
   * callback the real orchestrator wires into every channel. Factored out
   * of the /api/messages HTTP route so it can also be driven directly
   * in-process (bypassing real HTTP/sockets) by the e2e test harness's
   * WebChannel driver — see e2e.test.ts's E2EDriver design.
   * Returns false (no-op) when conversationId/text fail validation.
   */
  ingestMessage(
    username: string,
    conversationId: string,
    text: string,
  ): boolean {
    if (!CONVERSATION_ID_PATTERN.test(conversationId) || !text) return false;

    const jid = buildJid(username, conversationId);
    this.dispatchToJid(jid, {
      id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: jid,
      sender: username,
      sender_name: username,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
    return true;
  }

  /**
   * Test-only hook: dispatches a fully-formed NewMessage (custom id,
   * timestamp, sender — whatever the e2e scenario script needs) straight
   * through WebChannel's real auto-register + onMessage() path, without
   * going through the HTTP /api/messages JSON body / field-generation
   * logic. Used by e2e.test.ts's WebChannelDriver so scenario scripts can
   * control timestamps precisely (needed for SQLite's strictly-increasing
   * message ordering under fake timers) while still exercising the same
   * registration/dispatch code every real inbound message goes through.
   */
  _ingestRawMessage(jid: string, message: NewMessage): void {
    this.dispatchToJid(jid, message);
  }

  private dispatchToJid(jid: string, message: NewMessage): void {
    const username = usernameFromJid(jid);
    // Auto-create on demand (scriptable test-harness convenience, matching
    // Feishu's auto-discovery of new chats) — the conversation title
    // falls back to its id if it wasn't created explicitly via the UI first.
    if (username && !this.opts.registeredGroups()[jid]) {
      const conversationId = jid.slice(`web:${username}:`.length);
      this.ensureConversationRegistered(
        username,
        conversationId,
        conversationId,
      );
    }
    this.opts.onMessage(jid, message);
  }

  /**
   * Test-only hook: registers a fake SSE subscriber (anything with a
   * `write(chunk: string)` method — a real http.ServerResponse in
   * production, a plain capture object in tests) for `username`, flushing
   * any buffered messages exactly like a real reconnecting browser tab
   * would via GET /api/stream. Lets e2e tests observe WebChannel's real
   * sendMessage()/outgoing-buffer behavior without opening a real socket.
   */
  _attachTestSubscriber(
    username: string,
    sink: Pick<http.ServerResponse, 'write'>,
  ): void {
    this.subscribe(username, sink as http.ServerResponse);
  }

  private subscribe(username: string, res: http.ServerResponse): void {
    let subscribers = this.streams.get(username);
    if (!subscribers) {
      subscribers = new Set();
      this.streams.set(username, subscribers);
    }
    subscribers.add(res);

    // Flush anything buffered while this user had no live stream
    const buffered = this.outgoingQueue.get(username);
    if (buffered && buffered.length > 0) {
      for (const { jid, text } of buffered) {
        this.sentCounter += 1;
        this.pushEvent(username, {
          jid,
          text,
          messageId: `web-sent-${this.sentCounter}`,
        });
      }
      this.outgoingQueue.delete(username);
    }
  }

  private pushEvent(
    username: string,
    payload: { jid: string; text: string; messageId: string },
  ): void {
    const subscribers = this.streams.get(username);
    if (!subscribers) return;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of subscribers) {
      res.write(data);
    }
  }

  // --- HTTP routing ---

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method || 'GET';

    if (method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(WEB_UI_HTML);
      return;
    }

    if (method === 'POST' && pathname === '/login') {
      await this.handleLogin(req, res);
      return;
    }

    if (method === 'POST' && pathname === '/logout') {
      this.handleLogout(req, res);
      return;
    }

    if (method === 'GET' && pathname === '/api/me') {
      const session = this.authenticate(req);
      if (!session) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthenticated' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ username: session.username }));
      return;
    }

    if (method === 'GET' && pathname === '/api/conversations') {
      const session = this.authenticate(req);
      if (!session) return this.unauthorized(res);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.listConversations(session.username)));
      return;
    }

    if (method === 'POST' && pathname === '/api/conversations') {
      const session = this.authenticate(req);
      if (!session) return this.unauthorized(res);
      const body = await this.readJsonBody(req);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'title is required' }));
        return;
      }
      const conversationId = generateConversationId(title);
      this.ensureConversationRegistered(
        session.username,
        conversationId,
        title,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversationId, name: title }));
      return;
    }

    if (method === 'GET' && pathname === '/api/history') {
      const session = this.authenticate(req);
      if (!session) return this.unauthorized(res);
      const conversationId = url.searchParams.get('conversationId') || '';
      if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid conversationId' }));
        return;
      }
      const jid = buildJid(session.username, conversationId);
      const history = searchMessages(jid, { limit: 100 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(history));
      return;
    }

    if (method === 'POST' && pathname === '/api/messages') {
      const session = this.authenticate(req);
      if (!session) return this.unauthorized(res);
      const body = await this.readJsonBody(req);
      const conversationId =
        typeof body.conversationId === 'string' ? body.conversationId : '';
      const text = typeof body.text === 'string' ? body.text : '';
      if (!this.ingestMessage(session.username, conversationId, text)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'conversationId and text are required' }),
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === 'GET' && pathname === '/api/stream') {
      const session = this.authenticate(req);
      if (!session) return this.unauthorized(res);
      this.handleStream(session.username, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  private unauthorized(res: http.ServerResponse): void {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthenticated' }));
  }

  private handleStream(username: string, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    this.subscribe(username, res);

    const subscribers = this.streams.get(username);
    res.req.on('close', () => {
      subscribers!.delete(res);
    });
  }

  private async handleLogin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readJsonBody(req);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const expected = this.users.get(username);
    if (!expected || expected !== password) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid credentials' }));
      return;
    }

    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, {
      username,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax`,
    });
    res.end(JSON.stringify({ username }));

    // First login for this user - report chat metadata for their "root"
    // presence so getAvailableGroups()-style discovery has something to
    // show even before they create their first named conversation.
    this.opts.onChatMetadata(
      `web:${username}:_root`,
      new Date().toISOString(),
      username,
      'web',
      false,
    );
  }

  private handleLogout(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const token = this.cookieFrom(req);
    if (token) this.sessions.delete(token);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
  }

  private authenticate(req: http.IncomingMessage): Session | undefined {
    const token = this.cookieFrom(req);
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }

  private cookieFrom(req: http.IncomingMessage): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const [rawName, ...rest] = part.trim().split('=');
      if (rawName === SESSION_COOKIE_NAME) return rest.join('=');
    }
    return undefined;
  }

  private readJsonBody(
    req: http.IncomingMessage,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });
  }

  private listConversations(
    username: string,
  ): Array<{ conversationId: string; name: string }> {
    const groups = this.opts.registeredGroups();
    const prefix = `web:${username}:`;
    const result: Array<{ conversationId: string; name: string }> = [];
    for (const [jid, group] of Object.entries(groups)) {
      if (jid.startsWith(prefix) && jid !== `${prefix}_root`) {
        result.push({
          conversationId: jid.slice(prefix.length),
          name: group.name,
        });
      }
    }
    return result;
  }

  /** Registers a new conversation as its own isolated RegisteredGroup, mirroring Feishu's auto-registration flow. */
  private ensureConversationRegistered(
    username: string,
    conversationId: string,
    title: string,
  ): void {
    const jid = buildJid(username, conversationId);
    const groups = this.opts.registeredGroups();
    if (groups[jid]) return;

    const folder = `web_${sanitizeFolderPart(username)}_${sanitizeFolderPart(conversationId)}`;
    const group: RegisteredGroup = {
      name: title,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false, // solo conversation, no @mention needed
      isMain: false,
    };

    // registerGroup persistence (DB write + folder creation) is owned by
    // index.ts's registerGroup(), reachable only via the registerGroup IPC
    // dependency injected through ChannelOpts in the real orchestrator.
    // Channels don't call db.ts's setRegisteredGroup()/mkdir directly for
    // their OWN conversations the way Feishu does for discovered chats,
    // because Feishu auto-registers chats it didn't create; Web's
    // conversations are always explicitly created by an authenticated user
    // through this channel, so the registration path is the same one
    // index.ts itself uses.
    groups[jid] = group;
    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      title,
      'web',
      false,
    );
    logger.info({ jid, folder }, 'Web channel: conversation registered');
  }
}

export function parseWebUsers(raw: string): Map<string, string> {
  const users = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const username = trimmed.slice(0, idx).trim();
    const password = trimmed.slice(idx + 1).trim();
    if (username && password) users.set(username, password);
  }
  return users;
}

export function usernameFromJid(jid: string): string | undefined {
  if (!jid.startsWith('web:')) return undefined;
  const rest = jid.slice('web:'.length);
  const idx = rest.indexOf(':');
  return idx === -1 ? rest : rest.slice(0, idx);
}

export function buildJid(username: string, conversationId: string): string {
  return `web:${username}:${conversationId}`;
}

function sanitizeFolderPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'x'
  );
}

export function generateConversationId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${slug || 'conv'}-${suffix}`;
}

registerChannel('web', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['WEB_USERS']);
  if (!envVars.WEB_USERS) {
    logger.warn('Web: WEB_USERS not set');
    return null;
  }
  return new WebChannel(opts);
});
