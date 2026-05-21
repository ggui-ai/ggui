/**
 * ChatThreadProvider — outer loader for chat-thread mounts.
 *
 * Load-first, mount-once: gates render until persisted history is
 * resolved, then mounts children with a frozen seed. Children call
 * `useChatThread()` which reads `seed` from context and passes it to
 * `useInvoke` via `initialMessages`. `useInvoke` captures
 * `initialMessages` with `useState(fn)` at mount — a late-arriving seed
 * would be silently dropped. The gate enforces the right order.
 *
 * Ambient config: the Provider owns `bearerToken` + `aiContext` so
 * shell components (ChatShell, AgentShell) stay dumb — they just call
 * `useChatThread()` and get wired credentials without knowing the host's
 * auth model.
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { AppDisplayConfig } from '@ggui-ai/protocol';
import { GguiProvider } from '../components/GguiProvider';
import { contentGroupsToConversationMessages } from '../chat-helpers/message-groups';
import type { ContentGroup } from '../chat-helpers/message-groups';
import type { ConversationMessage } from '../invoke/useInvoke';
import type { MessageStorageAdapter, StoredMessage } from './adapters/types';

interface ChatThreadContextValue {
  threadId: string;
  appId: string;
  adapter: MessageStorageAdapter;
  /** Seed built from persisted history; passed to `useInvoke.initialMessages`. */
  seed: ConversationMessage[];
  persistedMessages: StoredMessage[];
  /** Imperative refetch — used by `useChatThread` after a successful append. */
  refetch: () => Promise<void>;
  /** Provider-level auth; shells don't see it directly. */
  bearerToken?: string;
  /** Provider-level metadata stamped on persisted messages. */
  aiContext?: Record<string, unknown>;
}

const ctx = createContext<ChatThreadContextValue | null>(null);

export function useChatThreadContext(): ChatThreadContextValue {
  const value = useContext(ctx);
  if (!value) {
    throw new Error(
      'useChatThreadContext requires a <ChatThreadProvider> ancestor',
    );
  }
  return value;
}

export interface ChatThreadProviderProps {
  threadId: string;
  appId: string;
  appConfig?: AppDisplayConfig;
  /**
   * Message-storage adapter. `ThreadActionsAdapter` is consumed separately
   * by thread-list UIs — not required by `useChatThread`.
   */
  adapter: MessageStorageAdapter;
  /** Bearer token used by `useInvoke` for authenticated apps. */
  bearerToken?: string;
  /** Ambient AI metadata (appId, shellType, servingRegion, …). */
  aiContext?: Record<string, unknown>;
  /** Shown while the initial history load is in flight. */
  loadingFallback?: React.ReactNode;
  children: React.ReactNode;
}

export function ChatThreadProvider({
  threadId,
  appId,
  appConfig,
  adapter,
  bearerToken,
  aiContext,
  loadingFallback,
  children,
}: ChatThreadProviderProps) {
  const [persistedMessages, setPersistedMessages] = useState<
    StoredMessage[] | null
  >(null);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useMemo(
    () => async () => {
      try {
        const msgs = await adapter.loadMessages(threadId);
        setPersistedMessages([...msgs].sort((a, b) => a.seq - b.seq));
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [threadId, adapter],
  );

  useEffect(() => {
    void refetch();
    const unsub = adapter.observeMessages(
      threadId,
      (msgs) => setPersistedMessages([...msgs].sort((a, b) => a.seq - b.seq)),
      (err) => setError(err),
    );
    return unsub;
  }, [threadId, adapter, refetch]);

  if (error) throw error;
  if (persistedMessages === null) {
    return <>{loadingFallback ?? null}</>;
  }

  // Build seed for useInvoke. system-role messages are persisted + rendered
  // in the timeline, but NEVER included in the invoke seed — they're
  // client-side annotations (banners like "agent revoked permission"), not
  // LLM turns. Leaking them into `history` pollutes invoke context.
  const seedGroups = persistedMessages
    .filter((m) => m.authorRole !== 'system')
    .map(storedMessageToContentGroup);
  const seed = contentGroupsToConversationMessages(seedGroups);

  return (
    <GguiProvider appId={appId} appConfig={appConfig ?? null}>
      <ctx.Provider
        value={{
          threadId,
          appId,
          adapter,
          seed,
          persistedMessages,
          refetch,
          bearerToken,
          aiContext,
        }}
      >
        {/* key forces remount on threadId change — fresh seed. */}
        <React.Fragment key={threadId}>{children}</React.Fragment>
      </ctx.Provider>
    </GguiProvider>
  );
}

/**
 * Pre-condition: caller has already filtered out system-role messages.
 * `ContentGroup.authorRole` is constrained to `'user' | 'agent'` because
 * those are the roles that participate in invoke history.
 */
function storedMessageToContentGroup(m: StoredMessage): ContentGroup {
  if (m.authorRole === 'system') {
    throw new Error(
      'storedMessageToContentGroup: system messages must be filtered upstream',
    );
  }
  return {
    key: m.key,
    kind: m.kind === 'event' ? 'other' : m.kind,
    authorRole: m.authorRole,
    blocks: m.blocks,
    cardSnapshot: m.cardSnapshot,
    textPreview: m.textPreview,
  };
}
