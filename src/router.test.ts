import { describe, it, expect } from 'vitest';

import { findChannel } from './router.js';
import { Channel } from './types.js';

function makeChannel(name: string, ownsPrefix: string): Channel {
  return {
    name,
    connect: async () => {},
    sendMessage: async () => undefined,
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith(ownsPrefix),
    disconnect: async () => {},
  };
}

describe('findChannel', () => {
  it('resolves via the composite key channelType matching a channel name', () => {
    const slack = makeChannel('slack', 'slack:');
    const feishu = makeChannel('feishu', 'feishu:');
    expect(findChannel([slack, feishu], 'slack:C123')).toBe(slack);
    expect(findChannel([slack, feishu], 'feishu:oc_1')).toBe(feishu);
  });

  it('resolves bare WhatsApp JIDs (no prefix) via the whatsapp channel name', () => {
    const whatsapp = makeChannel('whatsapp', '');
    whatsapp.ownsJid = (jid: string) =>
      jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
    expect(findChannel([whatsapp], '123@g.us')).toBe(whatsapp);
  });

  it('falls back to ownsJid scan when parsed channelType matches no channel name', () => {
    // Simulates a legacy/renamed channel whose `name` no longer matches the
    // jid prefix convention parseGroupKey infers - resolution must not break.
    const legacy = makeChannel('legacy-whatsapp', '');
    legacy.ownsJid = (jid: string) => jid.endsWith('@g.us');
    expect(findChannel([legacy], '123@g.us')).toBe(legacy);
  });

  it('returns undefined when no channel owns the jid', () => {
    const slack = makeChannel('slack', 'slack:');
    expect(findChannel([slack], 'feishu:oc_1')).toBeUndefined();
  });
});
