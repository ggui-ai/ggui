/**
 * `createSelfHostedGguiAdapter` — FullChatStorageAdapter impl against
 * the `@ggui-ai/mcp-server` persistent-thread HTTP + SSE surface.
 *
 * Wire contract (fixed by the shipped server transport):
 *
 *   GET    /threads/:id/messages    → ListMessagesResult
 *   POST   /threads/:id/messages    → ThreadMessage (idempotent on key)
 *   PATCH  /threads/:id             → Thread (state-machine mutation)
 *   GET    /threads/:id/stream      → SSE `event: thread-message`
 *                                     frames carrying ThreadStreamEvent
 *
 * Honesty note: the OSS `InMemoryThreadStore` is the default backing
 * plane today. Server restart loses data. Durable persistence lands
 * with Step 6 (SQLite reference impl). The adapter itself is agnostic;
 * it's the same contract either way.
 */
import type {
  ListMessagesResult,
  Thread,
  ThreadMessage,
  ThreadStreamEvent,
} from '@ggui-ai/protocol';
import type {
  FullChatStorageAdapter,
  StoredMessage,
  ThreadStateAction,
} from './types.js';
import { httpRequest, threadsPath, type TransportConfig } from './transport.js';
import { openThreadStream } from './sse.js';

export interface SelfHostedAdapterOptions {
  readonly baseUrl: string;
  readonly pairingToken: string;
  /** Injected fetch override. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injected EventSource override. Defaults to the global
   *  `EventSource`; tests inject a fake. */
  readonly eventSource?: typeof EventSource;
}

export function createSelfHostedGguiAdapter(
  opts: SelfHostedAdapterOptions,
): FullChatStorageAdapter {
  const cfg: TransportConfig = {
    baseUrl: opts.baseUrl,
    pairingToken: opts.pairingToken,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };

  return {
    async loadMessages(threadId) {
      const path = `${threadsPath()}/${encodeURIComponent(threadId)}/messages`;
      const result = await httpRequest<ListMessagesResult>(cfg, path);
      return (result.messages ?? []).map(toStoredMessage);
    },

    observeMessages(threadId, onNext, onError) {
      const path = `${threadsPath()}/${encodeURIComponent(threadId)}/stream`;
      // Cumulative snapshot — SDK's MessageStorageAdapter expects full
      // list on every emit (matches the cloud adapter's observeQuery
      // semantics). Server SSE is incremental; we accumulate here so
      // the SDK sees one shape.
      const seen = new Map<number, StoredMessage>();

      const close = openThreadStream({
        baseUrl: opts.baseUrl,
        path,
        pairingToken: opts.pairingToken,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.eventSource ? { eventSource: opts.eventSource } : {}),
        onEvent: (event: ThreadStreamEvent) => {
          const next = toStoredMessage(event.message);
          seen.set(next.seq, next);
          onNext(sortedBySeq(seen));
        },
        onError: (err) => onError?.(err),
      });

      return close;
    },

    async appendMessage(input) {
      const path = `${threadsPath()}/${encodeURIComponent(input.threadId)}/messages`;
      const body: Record<string, unknown> = {
        key: input.key,
        authorRole: input.authorRole,
        kind: input.kind,
        blocks: input.blocks,
        textPreview: input.textPreview,
      };
      if (input.cardSnapshot !== undefined) body['cardSnapshot'] = input.cardSnapshot;
      if (input.aiContext !== undefined) body['aiContext'] = input.aiContext;
      const msg = await httpRequest<ThreadMessage>(cfg, path, {
        method: 'POST',
        body,
      });
      return toStoredMessage(msg);
    },

    async updateThreadState(threadId, action) {
      const path = `${threadsPath()}/${encodeURIComponent(threadId)}`;
      await httpRequest<Thread>(cfg, path, {
        method: 'PATCH',
        body: { action },
      });
    },
  };
}

/**
 * Project a protocol `ThreadMessage` onto the SDK's `StoredMessage`
 * shape. Field names mostly line up; the only divergence is `blocks`
 * (protocol ships `unknown[]`, SDK types it as `ContentBlock[]`). We
 * pass through — the server-side assertions upstream are what enforce
 * the ContentBlock vocabulary.
 */
function toStoredMessage(m: ThreadMessage): StoredMessage {
  const out: StoredMessage = {
    key: m.key,
    threadId: m.threadId,
    authorRole: m.authorRole,
    kind: m.kind,
    // Cast: protocol types `blocks` as `unknown[]` for forward-
    // compatibility with future block vocab; SDK narrows to
    // `ContentBlock[]`. Server-side validation at write time keeps
    // the narrow form honest in practice.
    blocks: m.blocks as StoredMessage['blocks'],
    cardSnapshot: m.cardSnapshot ?? null,
    textPreview: m.textPreview,
    seq: m.seq,
    at: m.at,
  };
  if (m.aiContext !== undefined) out.aiContext = m.aiContext;
  return out;
}

function sortedBySeq(map: Map<number, StoredMessage>): StoredMessage[] {
  const out = Array.from(map.values());
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// Re-export for consumer convenience.
export type { ThreadStateAction };
