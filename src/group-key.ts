/**
 * Explicit composite group identity: (channel_type, tenant_id, conversation_id).
 *
 * Historically, group identity was an implicit convention baked into the
 * chatJid string each channel produces (e.g. `slack:C123`, `feishu:oc_abc`,
 * bare WhatsApp JIDs like `123@g.us`). This module makes that shape explicit
 * so routing resolution, in-process queue partitioning, and DB lookups can
 * reason about identity as a real composite key instead of ad-hoc string
 * parsing scattered across the codebase.
 *
 * IMPORTANT: This is an internal representation only. The chatJid string
 * remains the external wire format used by channels, the DB, and IPC files -
 * nothing here changes what gets stored or sent externally. `tenantId` is
 * always `"default"` today (single-tenant deployment); the field exists so
 * multi-tenant support can be added later without another identity refactor.
 */

export interface GroupKey {
  channelType: string;
  tenantId: string;
  conversationId: string;
}

export const DEFAULT_TENANT_ID = 'default';

/**
 * Parse a raw chatJid string (as produced by a Channel implementation) into
 * its explicit composite identity.
 *
 * Known conventions:
 * - `${channelType}:${conversationId}` for prefixed channels (feishu, slack,
 *   wecom, tg, dc/discord, ...).
 * - Bare WhatsApp JIDs (`...@g.us` groups, `...@s.whatsapp.net` DMs) have no
 *   prefix at all - the whole string is both the channelType marker and the
 *   conversationId.
 * - Anything else falls back to channelType "unknown" with the full string
 *   as conversationId, so parsing never throws on unexpected input.
 */
export function parseGroupKey(chatJid: string): GroupKey {
  if (chatJid.endsWith('@g.us') || chatJid.endsWith('@s.whatsapp.net')) {
    return {
      channelType: 'whatsapp',
      tenantId: DEFAULT_TENANT_ID,
      conversationId: chatJid,
    };
  }

  const colonIndex = chatJid.indexOf(':');
  if (colonIndex > 0) {
    const channelType = chatJid.slice(0, colonIndex);
    const conversationId = chatJid.slice(colonIndex + 1);
    if (channelType && conversationId) {
      return { channelType, tenantId: DEFAULT_TENANT_ID, conversationId };
    }
  }

  return {
    channelType: 'unknown',
    tenantId: DEFAULT_TENANT_ID,
    conversationId: chatJid,
  };
}

/** Canonical string form of a composite key, used for internal lookup keys. */
export function formatGroupKey(key: GroupKey): string {
  return `${key.channelType}:${key.tenantId}:${key.conversationId}`;
}

/** Convenience: chatJid -> canonical composite-key string in one step. */
export function groupKeyFromChatJid(chatJid: string): string {
  return formatGroupKey(parseGroupKey(chatJid));
}
