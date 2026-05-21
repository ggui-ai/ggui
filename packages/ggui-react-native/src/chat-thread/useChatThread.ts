/**
 * useChatThread — adapter-driven chat persistence + streaming.
 *
 *   - Reads threadId / adapter / seed / bearerToken / aiContext from
 *     `ChatThreadProvider` context.
 *   - Wires seed into `useInvoke.initialMessages` (gated by Provider).
 *   - Persists finalized messages via `adapter.appendMessage` — dedup at
 *     the CONTENT-GROUP level, not invoke-message level, so a partial
 *     failure of one group (e.g. card write) can retry without skipping
 *     the other groups in the same message.
 *   - Online: `send(text)` → `invoke.send`.
 *   - Offline: `send(text)` → `enqueueEntry(outboxStorage, ...)`. The
 *     queued entry renders as a `{ isPending: true }` bubble in
 *     `messages` so the user sees what's waiting to replay.
 *   - Merges persisted + pending + live messages into one timeline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentBlock, ToolUseBlock } from '@ggui-ai/protocol';
import {
  useInvoke,
  type ConversationMessage,
  type InvokeError,
} from '../invoke/useInvoke';
import { useRafThrottled } from '../chat-helpers/useRafThrottled';
import { invokeMessageToContentGroups } from '../chat-helpers/message-groups';
import { useChatThreadContext } from './ChatThreadProvider';
import {
  dequeueByKey,
  enqueueEntry,
  listOutboxForThread,
  type OutboxEntry,
  type OutboxStorage,
} from './outbox';
import { useNetworkState } from './useNetworkState';

export interface UseChatThreadOptions {
  /** Overrides Provider-level bearerToken for unusual cases. */
  bearerToken?: string;
  /** Forwarded to `useInvoke`. */
  onToolUse?: (block: ToolUseBlock) => void;
  /** Overrides Provider-level aiContext on persisted messages. */
  aiContext?: unknown;
  /**
   * Durable outbox for offline sends. Defaults to `null` (disabled) —
   * offline `send()` will throw. Integrators that want offline UX pass
   * `createKvOutboxStorage(localStorage)` on web or
   * `createKvOutboxStorage(AsyncStorage)` on RN.
   */
  outboxStorage?: OutboxStorage | null;
  /**
   * Explicit online state override. When set, the hook ignores the
   * internal `useNetworkState` reading. Useful for tests and for RN
   * integrators wiring `@react-native-community/netinfo` themselves.
   */
  isOnline?: boolean;
}

export interface ChatThreadMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: ConversationMessage['content'];
  cardSnapshot: unknown | null;
  isStreaming: boolean;
  /** True while the user message sits in the outbox, waiting to replay. */
  isPending: boolean;
}

export interface UseChatThreadReturn {
  messages: ChatThreadMessage[];
  send: (text: string, opts?: { clientMessageId?: string }) => Promise<void>;
  isStreaming: boolean;
  error: Error | null;
}

export function useChatThread(
  options: UseChatThreadOptions = {},
): UseChatThreadReturn {
  const {
    threadId,
    adapter,
    seed,
    persistedMessages,
    refetch,
    bearerToken: providerBearerToken,
    aiContext: providerAiContext,
  } = useChatThreadContext();

  // Surface useInvoke's per-send error synchronously via a ref, so the
  // replay drain (below) can tell success from failure. useInvoke swallows
  // transport errors into its `error` state and resolves the send()
  // promise normally — without an onError handler, the drain can't
  // distinguish a success from a silent failure.
  const invokeErrorRef = useRef<InvokeError | null>(null);
  const invoke = useInvoke({
    initialMessages: seed,
    bearerToken: options.bearerToken ?? providerBearerToken,
    onToolUse: options.onToolUse,
    onError: (err) => {
      invokeErrorRef.current = err;
    },
  });

  const effectiveAiContext = options.aiContext ?? providerAiContext;

  // Online gate — caller override wins; otherwise read the hook.
  const liveOnline = useNetworkState();
  const isOnline = options.isOnline ?? liveOnline;
  const outboxStorage = options.outboxStorage ?? null;

  // Persistence idempotency is tracked at the CONTENT-GROUP level, not the
  // invoke-message level. Why: one invoke message can split into multiple
  // durable groups (text + card). If group g1 succeeds and g2 fails, we
  // must retry g2 without skipping the whole message. Adapter-level
  // idempotency on (threadId, key) makes concurrent retries safe.
  const persistedKeysRef = useRef<Set<string>>(
    new Set(persistedMessages.map((m) => m.key)),
  );
  // In-flight tracking prevents the same group.key from being submitted
  // twice during rapid re-renders before the first write resolves.
  const inflightKeysRef = useRef<Set<string>>(new Set());

  // Pending outbox entries, kept in local state for UI rendering.
  // Mirrors the durable outboxStorage — `enqueueEntry` writes through to
  // storage AND this state; replay-on-reconnect drains both in lockstep.
  const [pendingEntries, setPendingEntries] = useState<OutboxEntry[]>([]);

  // Hydrate pending entries from durable storage on mount / thread change.
  useEffect(() => {
    if (!outboxStorage) {
      setPendingEntries([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const entries = await listOutboxForThread(outboxStorage, threadId);
      if (!cancelled) setPendingEntries(entries);
    })();
    return () => {
      cancelled = true;
    };
  }, [outboxStorage, threadId]);

  // Replay-on-reconnect. Drains the durable outbox serially whenever the
  // hook is online + has pending entries. The `isDrainingRef` lock keeps
  // us from re-entering while a drain is in flight — React will re-run
  // this effect on every setPendingEntries inside the drain, and the
  // lock short-circuits those without restarting.
  //
  // On per-entry failure we stop the drain and leave the remaining
  // entries in storage. The next isOnline flip (or the next hydrate)
  // resumes from where we left off. useInvoke's existing
  // `{ clientMessageId }` idempotency on the wire makes the success-
  // before-crash case safe: a resumed replay of an already-delivered
  // entry reuses the same id and either no-ops or collapses cleanly.
  const isDrainingRef = useRef(false);
  // useInvoke's identity changes on every render (options is a fresh
  // object). Capturing `invoke` directly in the drain effect's dep list
  // would cancel the in-flight drain on every setState inside useInvoke.
  // Access through a ref instead.
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

  useEffect(() => {
    if (!isOnline) return;
    if (!outboxStorage) return;
    if (isDrainingRef.current) return;

    isDrainingRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        // Re-read durable storage each pass — a send() that enqueued
        // between this effect scheduling and firing still gets drained.
        const entries = await listOutboxForThread(outboxStorage, threadId);
        for (const entry of entries) {
          if (cancelled) break;
          invokeErrorRef.current = null;
          try {
            await invokeRef.current.send(entry.text, {
              clientMessageId: entry.clientMessageId,
            });
          } catch (err) {
            // useInvoke.send does not reject on transport errors today,
            // but defend against future changes.
            // eslint-disable-next-line no-console
            console.warn(
              '[useChatThread] replay threw for',
              entry.clientMessageId,
              err,
            );
            break;
          }
          if (invokeErrorRef.current) {
            // eslint-disable-next-line no-console
            console.warn(
              '[useChatThread] replay failed for',
              entry.clientMessageId,
              invokeErrorRef.current,
            );
            break;
          }
          await dequeueByKey(outboxStorage, entry.clientMessageId);
          if (!cancelled) {
            setPendingEntries((prev) =>
              prev.filter((e) => e.clientMessageId !== entry.clientMessageId),
            );
          }
        }
      } finally {
        isDrainingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOnline, outboxStorage, threadId]);

  // Sync persistedKeysRef when observeMessages delivers new rows (e.g.
  // written by another device). Prevents redundant re-persistence.
  useEffect(() => {
    for (const m of persistedMessages) {
      persistedKeysRef.current.add(m.key);
    }
  }, [persistedMessages]);

  // Persistence: on end_turn, split invoke message into ContentGroups and
  // write each to the adapter. Each group is its own idempotency unit.
  useEffect(() => {
    for (const msg of invoke.messages) {
      if (msg.isStreaming) continue;
      const groups = invokeMessageToContentGroups(msg);
      for (const group of groups) {
        if (persistedKeysRef.current.has(group.key)) continue;
        if (inflightKeysRef.current.has(group.key)) continue;
        inflightKeysRef.current.add(group.key);

        void (async () => {
          try {
            await adapter.appendMessage({
              threadId,
              key: group.key,
              authorRole: group.authorRole,
              kind: group.kind === 'other' ? 'event' : group.kind,
              blocks: group.blocks,
              cardSnapshot: group.cardSnapshot ?? undefined,
              textPreview: group.textPreview,
              aiContext: effectiveAiContext,
            });
            persistedKeysRef.current.add(group.key);
            await refetch();
          } catch (err) {
            // Keep the key out of persistedKeysRef so the next observeMessages
            // tick or invoke update can retry. Adapter idempotency makes the
            // eventual-retry-after-temporary-success case safe.
            // eslint-disable-next-line no-console
            console.warn('[useChatThread] appendMessage failed', group.key, err);
          } finally {
            inflightKeysRef.current.delete(group.key);
          }
        })();
      }
    }
  }, [invoke.messages, threadId, adapter, refetch, effectiveAiContext]);

  const send = useCallback(
    async (text: string, opts?: { clientMessageId?: string }) => {
      const clientMessageId =
        opts?.clientMessageId ?? `user_${Math.random().toString(36).slice(2, 12)}`;
      if (isOnline) {
        await invoke.send(text, { clientMessageId });
        return;
      }
      if (!outboxStorage) {
        throw new Error(
          'useChatThread: offline send attempted without outboxStorage. ' +
            'Provide `outboxStorage: createKvOutboxStorage(localStorage)` ' +
            '(web) or an AsyncStorage equivalent on RN to enable the ' +
            'durable queue.',
        );
      }
      const entry: OutboxEntry = {
        threadId,
        clientMessageId,
        text,
        queuedAt: Date.now(),
      };
      await enqueueEntry(outboxStorage, entry);
      setPendingEntries((prev) =>
        prev.some((e) => e.clientMessageId === entry.clientMessageId)
          ? prev
          : [...prev, entry],
      );
    },
    [invoke, isOnline, outboxStorage, threadId],
  );

  // Unified timeline: persisted + still-live invoke messages + pending
  // outbox entries (rendered as user bubbles with `isPending: true`).
  // Outbox entries never overlap with live/persisted because their
  // clientMessageId is what useInvoke adopts as the user-message id on
  // replay — so once replayed and persisted, the pending bubble is
  // replaced by the real one under the same id.
  const throttledLive = useRafThrottled(invoke.messages);
  const messages = useMemo<ChatThreadMessage[]>(() => {
    const persistedInvokeIds = new Set(
      persistedMessages.map(
        (m) => m.key.split('-').slice(0, -1).join('-') || m.key,
      ),
    );
    const liveIds = new Set(throttledLive.map((m) => m.id));
    const liveMapped = throttledLive
      .filter((m) => !persistedInvokeIds.has(m.id))
      .map<ChatThreadMessage>((m) => ({
        id: m.id,
        role: m.role,
        blocks: m.content,
        cardSnapshot: extractFirstCardSnapshot(m.content),
        isStreaming: m.isStreaming,
        isPending: false,
      }));
    const persistedMapped = persistedMessages.map<ChatThreadMessage>((p) => ({
      id: p.key,
      role:
        p.authorRole === 'user'
          ? 'user'
          : p.authorRole === 'agent'
            ? 'assistant'
            : 'system',
      blocks: p.blocks,
      cardSnapshot: p.cardSnapshot,
      isStreaming: false,
      isPending: false,
    }));
    // Pending: hide entries whose clientMessageId already shows up as a
    // live or persisted user message — replay has already landed them.
    const pendingMapped = pendingEntries
      .filter(
        (e) => !liveIds.has(e.clientMessageId) && !persistedInvokeIds.has(e.clientMessageId),
      )
      .map<ChatThreadMessage>((e) => ({
        id: e.clientMessageId,
        role: 'user',
        blocks: [{ type: 'text', text: e.text } satisfies ContentBlock],
        cardSnapshot: null,
        isStreaming: false,
        isPending: true,
      }));
    return [...persistedMapped, ...liveMapped, ...pendingMapped];
  }, [persistedMessages, throttledLive, pendingEntries]);

  return {
    messages,
    send,
    isStreaming: invoke.isStreaming,
    error: invoke.error ? new Error(invoke.error.message) : null,
  };
}

function extractFirstCardSnapshot(
  blocks: ConversationMessage['content'],
): unknown | null {
  for (const b of blocks) {
    if (b.type === 'tool_result') {
      const content = b.content as unknown;
      if (typeof content !== 'object' || content === null) continue;
      const rec = content as Record<string, unknown>;
      if (rec.stackItem && typeof rec.stackItem === 'object') return rec.stackItem;
      if (typeof rec.id === 'string' && typeof rec.componentCode === 'string') {
        return rec;
      }
    }
  }
  return null;
}
