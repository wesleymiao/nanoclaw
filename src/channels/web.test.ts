import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'http';

// ── Mock dependencies before importing WebChannel ──────────

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /@Andy/i,
  GROUPS_DIR: '/tmp/test-groups',
}));

vi.mock('../db.js', () => ({
  searchMessages: vi.fn(() => []),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const env: Record<string, string> = {
      WEB_USERS: 'alice:secret1,bob:secret2',
      WEB_PORT: '0', // random port for tests
    };
    return Object.fromEntries(keys.map((k) => [k, env[k] || '']));
  }),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { WebChannel, parseWebUsers, usernameFromJid, buildJid, generateConversationId } =
  await import('./web.js');
const { searchMessages } = await import('../db.js');

// ── Helpers ─────────────────────────────────────────────────

function makeOpts() {
  const groups: Record<string, any> = {};
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => groups),
  };
}

/** Issues a request against a running channel's HTTP server and returns the parsed response. */
async function request(
  port: number,
  method: string,
  urlPath: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: any = raw;
          try {
            body = JSON.parse(raw);
          } catch {
            // non-JSON response (e.g. index.html) — leave as raw string
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sessionCookie(headers: http.IncomingHttpHeaders): string {
  const setCookie = headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (raw || '').split(';')[0];
}

// ── Tests ───────────────────────────────────────────────────

describe('WebChannel', () => {
  describe('registration', () => {
    it('creates channel when WEB_USERS is present', () => {
      const channel = new WebChannel(makeOpts());
      expect(channel.name).toBe('web');
    });

    it('throws when WEB_USERS is empty', async () => {
      vi.resetModules();
      vi.doMock('../env.js', () => ({
        readEnvFile: vi.fn(() => ({})),
      }));
      const { WebChannel: EmptyWebChannel } = await import('./web.js');
      expect(() => new EmptyWebChannel(makeOpts())).toThrow();
      vi.doUnmock('../env.js');
      vi.resetModules();
    });

    it('ownsJid for web: prefix', () => {
      const channel = new WebChannel(makeOpts());
      expect(channel.ownsJid('web:alice:conv1')).toBe(true);
      expect(channel.ownsJid('feishu:123')).toBe(false);
      expect(channel.ownsJid('slack:123')).toBe(false);
    });
  });

  describe('helper functions', () => {
    it('parseWebUsers parses comma-separated username:password pairs', () => {
      const users = parseWebUsers('alice:pass1, bob:pass2');
      expect(users.get('alice')).toBe('pass1');
      expect(users.get('bob')).toBe('pass2');
      expect(users.size).toBe(2);
    });

    it('parseWebUsers ignores malformed entries', () => {
      const users = parseWebUsers('alice:pass1,,noPasswordHere,:onlypass');
      expect(users.size).toBe(1);
      expect(users.get('alice')).toBe('pass1');
    });

    it('usernameFromJid extracts username from composite jid', () => {
      expect(usernameFromJid('web:alice:my-conv')).toBe('alice');
      expect(usernameFromJid('web:alice')).toBe('alice');
      expect(usernameFromJid('feishu:123')).toBeUndefined();
    });

    it('buildJid composes username and conversationId', () => {
      expect(buildJid('alice', 'conv1')).toBe('web:alice:conv1');
    });

    it('generateConversationId produces a slug with random suffix', () => {
      const id1 = generateConversationId('My Trip Plans!');
      const id2 = generateConversationId('My Trip Plans!');
      expect(id1).toMatch(/^my-trip-plans-[a-f0-9]{6}$/);
      expect(id1).not.toBe(id2); // random suffix keeps ids unique
    });
  });

  describe('connect/disconnect', () => {
    let channel: any;

    afterEach(async () => {
      if (channel) await channel.disconnect();
    });

    it('starts HTTP server on connect', async () => {
      channel = new WebChannel(makeOpts());
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('stops server on disconnect', async () => {
      channel = new WebChannel(makeOpts());
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('HTTP API', () => {
    let channel: any;
    let opts: ReturnType<typeof makeOpts>;
    let port: number;

    afterEach(async () => {
      if (channel) await channel.disconnect();
    });

    async function bootstrap() {
      opts = makeOpts();
      channel = new WebChannel(opts);
      await channel.connect();
      port = (channel as any).server.address().port;
    }

    it('rejects invalid login credentials', async () => {
      await bootstrap();
      const res = await request(port, 'POST', '/login', {
        body: { username: 'alice', password: 'wrong' },
      });
      expect(res.status).toBe(401);
    });

    it('accepts valid login and sets a session cookie', async () => {
      await bootstrap();
      const res = await request(port, 'POST', '/login', {
        body: { username: 'alice', password: 'secret1' },
      });
      expect(res.status).toBe(200);
      expect(res.body.username).toBe('alice');
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('rejects unauthenticated access to protected endpoints', async () => {
      await bootstrap();
      const res = await request(port, 'GET', '/api/conversations');
      expect(res.status).toBe(401);
    });

    it('creates a conversation and lists it back', async () => {
      await bootstrap();
      const login = await request(port, 'POST', '/login', {
        body: { username: 'alice', password: 'secret1' },
      });
      const cookie = sessionCookie(login.headers);

      const created = await request(port, 'POST', '/api/conversations', {
        body: { title: 'Trip Planning' },
        cookie,
      });
      expect(created.status).toBe(200);
      expect(created.body.conversationId).toMatch(/^trip-planning-[a-f0-9]{6}$/);

      const list = await request(port, 'GET', '/api/conversations', { cookie });
      expect(list.status).toBe(200);
      expect(list.body).toEqual([
        { conversationId: created.body.conversationId, name: 'Trip Planning' },
      ]);
    });

    it('delivers posted messages via onMessage with the composite jid', async () => {
      await bootstrap();
      const login = await request(port, 'POST', '/login', {
        body: { username: 'alice', password: 'secret1' },
      });
      const cookie = sessionCookie(login.headers);

      await request(port, 'POST', '/api/messages', {
        body: { conversationId: 'quick-chat', text: 'hello there' },
        cookie,
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'web:alice:quick-chat',
        expect.objectContaining({
          content: 'hello there',
          sender: 'alice',
          chat_jid: 'web:alice:quick-chat',
        }),
      );
    });

    it('auto-registers a conversation on first message to an unknown id', async () => {
      await bootstrap();
      const login = await request(port, 'POST', '/login', {
        body: { username: 'alice', password: 'secret1' },
      });
      const cookie = sessionCookie(login.headers);

      await request(port, 'POST', '/api/messages', {
        body: { conversationId: 'auto-conv', text: 'hi' },
        cookie,
      });

      expect(opts.registeredGroups()['web:alice:auto-conv']).toBeDefined();
      expect(opts.registeredGroups()['web:alice:auto-conv'].isMain).toBe(false);
    });

    it('rejects invalid conversationId format on /api/messages', async () => {
      await bootstrap();
      const login = await request(port, 'POST', '/login', {
        body: { username: 'alice', password: 'secret1' },
      });
      const cookie = sessionCookie(login.headers);

      const res = await request(port, 'POST', '/api/messages', {
        body: { conversationId: 'Not Valid!', text: 'hi' },
        cookie,
      });
      expect(res.status).toBe(400);
    });

    it('returns history for a conversation via searchMessages', async () => {
      await bootstrap();
      (searchMessages as any).mockReturnValueOnce([
        { sender_name: 'alice', content: 'hi', timestamp: 't1', is_from_me: 0 },
      ]);
      const login = await request(port, 'POST', '/login', {
        body: { username: 'alice', password: 'secret1' },
      });
      const cookie = sessionCookie(login.headers);

      const res = await request(
        port,
        'GET',
        '/api/history?conversationId=some-conv',
        { cookie },
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { sender_name: 'alice', content: 'hi', timestamp: 't1', is_from_me: 0 },
      ]);
      expect(searchMessages).toHaveBeenCalledWith('web:alice:some-conv', {
        limit: 100,
      });
    });

    it('logs out and invalidates the session', async () => {
      await bootstrap();
      const login = await request(port, 'POST', '/login', {
        body: { username: 'alice', password: 'secret1' },
      });
      const cookie = sessionCookie(login.headers);

      await request(port, 'POST', '/logout', { cookie });

      const res = await request(port, 'GET', '/api/conversations', { cookie });
      expect(res.status).toBe(401);
    });
  });

  describe('sendMessage buffering', () => {
    it('queues messages when no SSE stream is connected', async () => {
      const opts = makeOpts();
      const channel = new WebChannel(opts);
      await channel.connect();
      try {
        const messageId = await channel.sendMessage('web:alice:conv1', 'buffered reply');
        expect(messageId).toBeDefined();
        expect((channel as any).outgoingQueue.get('alice')).toEqual([
          { jid: 'web:alice:conv1', text: 'buffered reply' },
        ]);
      } finally {
        await channel.disconnect();
      }
    });

    it('returns undefined for jids it does not own', async () => {
      const channel = new WebChannel(makeOpts());
      await channel.connect();
      try {
        const messageId = await channel.sendMessage('feishu:123', 'irrelevant');
        expect(messageId).toBeUndefined();
      } finally {
        await channel.disconnect();
      }
    });
  });
});
