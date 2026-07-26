import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * Persists a new RegisteredGroup: DB row (setRegisteredGroup), group
   * folder + CLAUDE.md template, and best-effort OneCLI agent creation —
   * the same registration path index.ts itself uses for IPC-driven group
   * registration. Channels that auto-register conversations/chats on the
   * fly (e.g. WebChannel creating a new conversation) must call this
   * instead of mutating the registeredGroups() map directly, or the
   * registration is lost on process restart (nothing else persists it).
   */
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
