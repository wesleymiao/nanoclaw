import { parseGroupKey } from './group-key.js';
import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<string | undefined> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

/**
 * Resolve the channel that owns a chatJid.
 *
 * Resolution is explicitly keyed by the composite group identity
 * (channel_type, tenant_id, conversation_id): the parsed channelType is
 * matched against each channel's own `name` first, falling back to the
 * original ownsJid() scan for any jid whose shape parseGroupKey doesn't
 * recognize (e.g. legacy/malformed values) so behavior is unchanged even
 * outside the known channel conventions.
 */
export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  const { channelType } = parseGroupKey(jid);
  const byType = channels.find(
    (c) => c.name === channelType && c.ownsJid(jid),
  );
  if (byType) return byType;
  return channels.find((c) => c.ownsJid(jid));
}
