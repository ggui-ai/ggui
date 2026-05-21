/**
 * Adapter-agnostic chat-thread tier. Named re-exports only — no `export *`
 * (parity-test policy).
 */
export { ChatThreadProvider, useChatThreadContext } from './ChatThreadProvider';
export type { ChatThreadProviderProps } from './ChatThreadProvider';

export { useChatThread } from './useChatThread';
export type {
  UseChatThreadOptions,
  UseChatThreadReturn,
  ChatThreadMessage,
} from './useChatThread';

export type {
  StoredMessage,
  MessageStorageAdapter,
  ThreadActionsAdapter,
  FullChatStorageAdapter,
  ThreadStateAction,
} from './adapters/types';

export { createKvOutboxStorage } from './outbox';
export type { OutboxEntry, OutboxStorage, KvLikeStorage } from './outbox';
export { useNetworkState } from './useNetworkState';

// ── Shell substrate ──────────────────────────────────────────────────
//
// @experimental Shell abstraction types. Consumed by ChatShell and the
// (in-progress) AgentShell. These types describe the experience-policy
// shape a host app uses to choose and configure a shell.
export type ShellId = 'chat' | 'agent';
export type UnsupportedContentMode = 'handoff' | 'overlay' | 'hidden';

export interface ExperiencePolicy {
  defaultShell: ShellId;
  allowShellToggle: boolean;
  preferenceScope: 'user' | 'app' | 'device' | 'forced';
  unsupportedContentMode?: UnsupportedContentMode;
  reducedMotion?: boolean;
  idleResetMs?: number;
}

export const DEFAULT_POLICY: ExperiencePolicy = {
  defaultShell: 'chat',
  allowShellToggle: true,
  preferenceScope: 'user',
  unsupportedContentMode: 'handoff',
};
