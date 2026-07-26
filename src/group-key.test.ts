import { describe, it, expect } from 'vitest';

import {
  parseGroupKey,
  formatGroupKey,
  groupKeyFromChatJid,
  DEFAULT_TENANT_ID,
} from './group-key.js';

describe('parseGroupKey', () => {
  it('parses feishu chatJid', () => {
    expect(parseGroupKey('feishu:oc_abc123')).toEqual({
      channelType: 'feishu',
      tenantId: 'default',
      conversationId: 'oc_abc123',
    });
  });

  it('parses slack chatJid', () => {
    expect(parseGroupKey('slack:C0123456789')).toEqual({
      channelType: 'slack',
      tenantId: 'default',
      conversationId: 'C0123456789',
    });
  });

  it('parses wecom chatJid', () => {
    expect(parseGroupKey('wecom:123')).toEqual({
      channelType: 'wecom',
      tenantId: 'default',
      conversationId: '123',
    });
  });

  it('parses telegram chatJid', () => {
    expect(parseGroupKey('tg:987654')).toEqual({
      channelType: 'tg',
      tenantId: 'default',
      conversationId: '987654',
    });
  });

  it('parses discord chatJid', () => {
    expect(parseGroupKey('dc:555')).toEqual({
      channelType: 'dc',
      tenantId: 'default',
      conversationId: '555',
    });
  });

  it('parses bare WhatsApp group JID', () => {
    expect(parseGroupKey('12345@g.us')).toEqual({
      channelType: 'whatsapp',
      tenantId: 'default',
      conversationId: '12345@g.us',
    });
  });

  it('parses bare WhatsApp DM JID', () => {
    expect(parseGroupKey('12345@s.whatsapp.net')).toEqual({
      channelType: 'whatsapp',
      tenantId: 'default',
      conversationId: '12345@s.whatsapp.net',
    });
  });

  it('falls back to "unknown" for unrecognized shapes without throwing', () => {
    expect(parseGroupKey('random-string')).toEqual({
      channelType: 'unknown',
      tenantId: 'default',
      conversationId: 'random-string',
    });
  });

  it('falls back to "unknown" for a leading colon with empty channelType', () => {
    expect(parseGroupKey(':abc')).toEqual({
      channelType: 'unknown',
      tenantId: 'default',
      conversationId: ':abc',
    });
  });

  it('always uses the default tenant id today', () => {
    expect(parseGroupKey('slack:C1').tenantId).toBe(DEFAULT_TENANT_ID);
  });
});

describe('formatGroupKey / groupKeyFromChatJid', () => {
  it('formats a GroupKey to its canonical string', () => {
    expect(
      formatGroupKey({
        channelType: 'slack',
        tenantId: 'default',
        conversationId: 'C123',
      }),
    ).toBe('slack:default:C123');
  });

  it('round-trips chatJid -> composite key string for every known channel', () => {
    expect(groupKeyFromChatJid('feishu:oc_1')).toBe('feishu:default:oc_1');
    expect(groupKeyFromChatJid('slack:C1')).toBe('slack:default:C1');
    expect(groupKeyFromChatJid('wecom:1')).toBe('wecom:default:1');
    expect(groupKeyFromChatJid('tg:1')).toBe('tg:default:1');
    expect(groupKeyFromChatJid('dc:1')).toBe('dc:default:1');
    expect(groupKeyFromChatJid('12345@g.us')).toBe(
      'whatsapp:default:12345@g.us',
    );
    expect(groupKeyFromChatJid('12345@s.whatsapp.net')).toBe(
      'whatsapp:default:12345@s.whatsapp.net',
    );
  });

  it('produces distinct keys for distinct conversations on the same channel', () => {
    expect(groupKeyFromChatJid('slack:C1')).not.toBe(
      groupKeyFromChatJid('slack:C2'),
    );
  });

  it('produces distinct keys across channels even with the same conversation id', () => {
    expect(groupKeyFromChatJid('slack:123')).not.toBe(
      groupKeyFromChatJid('wecom:123'),
    );
  });
});
