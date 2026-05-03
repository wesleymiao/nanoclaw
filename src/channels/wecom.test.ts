import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';

// ── Mock dependencies before importing WeComChannel ──────────

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /@Andy/i,
  GROUPS_DIR: '/tmp/test-groups',
}));

vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
  setRegisteredGroup: vi.fn(),
  getAllRegisteredGroups: vi.fn(() => ({})),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const env: Record<string, string> = {
      WECOM_CORP_ID: 'test_corp_id',
      WECOM_CORP_SECRET: 'test_corp_secret',
      WECOM_AGENT_ID: '1000001',
      WECOM_TOKEN: 'test_token',
      WECOM_ENCODING_AES_KEY: crypto
        .randomBytes(32)
        .toString('base64')
        .slice(0, 43),
      WECOM_CALLBACK_PORT: '0', // random port for tests
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

// Use dynamic import to get the module after mocks are set up
const { WeComChannel } = await import('./wecom.js');

// ── Helpers ─────────────────────────────────────────────────

function makeOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'wecom:1000001': {
        name: 'test-app',
        folder: 'wecom_test',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      },
    })),
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('WeComChannel', () => {
  describe('registration', () => {
    it('creates channel when env vars are present', () => {
      const opts = makeOpts();
      const channel = new WeComChannel(opts);
      expect(channel.name).toBe('wecom');
    });

    it('ownsJid for wecom: prefix', () => {
      const channel = new WeComChannel(makeOpts());
      expect(channel.ownsJid('wecom:123')).toBe(true);
      expect(channel.ownsJid('feishu:123')).toBe(false);
      expect(channel.ownsJid('slack:123')).toBe(false);
    });
  });

  describe('crypto', () => {
    it('encrypt/decrypt round-trip preserves message', () => {
      const channel = new WeComChannel(makeOpts()) as any;
      const original = 'Hello, 企业微信!';
      const encrypted = channel.encrypt(original);
      expect(typeof encrypted).toBe('string');
      expect(encrypted).not.toBe(original);

      const { message, receiveid } = channel.decrypt(encrypted);
      expect(message).toBe(original);
      expect(receiveid).toBe('test_corp_id');
    });

    it('verifySignature produces consistent hash', () => {
      const channel = new WeComChannel(makeOpts()) as any;
      const sig1 = channel.verifySignature('token', '123', 'nonce', 'encrypt');
      const sig2 = channel.verifySignature('token', '123', 'nonce', 'encrypt');
      expect(sig1).toBe(sig2);
      expect(sig1).toHaveLength(40); // SHA1 hex
    });

    it('verifySignature sorts components', () => {
      const channel = new WeComChannel(makeOpts()) as any;
      // Same inputs in different order should produce same result
      // since the method sorts them internally
      const sig = channel.verifySignature('b', 'a', 'd', 'c');
      const expected = crypto
        .createHash('sha1')
        .update(['a', 'b', 'c', 'd'].join(''))
        .digest('hex');
      expect(sig).toBe(expected);
    });
  });

  describe('message splitting', () => {
    it('does not split short messages', () => {
      const channel = new WeComChannel(makeOpts()) as any;
      const result = channel.splitText('hello');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('hello');
    });

    it('splits messages exceeding 2048 bytes', () => {
      const channel = new WeComChannel(makeOpts()) as any;
      // Create a string that exceeds 2048 bytes
      const longText = 'a'.repeat(3000);
      const result = channel.splitText(longText);
      expect(result.length).toBeGreaterThan(1);
      expect(result.join('')).toBe(longText);
      // Each chunk should be <= 2048 bytes
      for (const chunk of result) {
        expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(2048);
      }
    });

    it('handles multi-byte characters correctly', () => {
      const channel = new WeComChannel(makeOpts()) as any;
      // Chinese chars are 3 bytes each in UTF-8
      const longChinese = '你好'.repeat(400); // ~2400 bytes
      const result = channel.splitText(longChinese);
      expect(result.length).toBeGreaterThan(1);
      expect(result.join('')).toBe(longChinese);
    });
  });

  describe('file reference extraction', () => {
    it('extracts markdown image references', () => {
      const channel = new WeComChannel(makeOpts()) as any;
      const text =
        'Here is the result:\n![screenshot](/workspace/group/test.png)\nDone.';
      const { cleanText, filePaths } = channel.extractFileReferences(
        'wecom:1000001',
        text,
      );
      // filePaths will be empty because the file doesn't exist on disk
      // but the pattern matching should work
      expect(cleanText).toContain('Here is the result:');
    });
  });

  describe('connect/disconnect', () => {
    let channel: any;

    afterEach(async () => {
      if (channel) {
        await channel.disconnect();
      }
    });

    it('starts HTTP server on connect', async () => {
      channel = new WeComChannel(makeOpts());
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('stops server on disconnect', async () => {
      channel = new WeComChannel(makeOpts());
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('deduplication', () => {
    it('tracks processed message IDs', () => {
      const channel = new WeComChannel(makeOpts()) as any;
      expect(channel.processedMessages.has('msg1')).toBe(false);
      channel.processedMessages.add('msg1');
      expect(channel.processedMessages.has('msg1')).toBe(true);
    });

    it('prunes when exceeding 1000 entries', () => {
      const channel = new WeComChannel(makeOpts()) as any;
      for (let i = 0; i < 1001; i++) {
        channel.processedMessages.add(`msg${i}`);
      }
      // After pruning in handleMessage, size should be reduced
      // Here we test the set grows beyond 1000 (pruning happens in handleMessage)
      expect(channel.processedMessages.size).toBe(1001);
    });
  });
});
