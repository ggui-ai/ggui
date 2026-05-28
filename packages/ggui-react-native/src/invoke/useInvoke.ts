/**
 * useInvoke — React Native hook for the streamable invoke protocol (v1).
 *
 * Near-exact port of the web hook (`@ggui-ai/react/src/invoke/useInvoke.ts`).
 * Public API is identical — consumers should be able to migrate between web
 * and RN by swapping imports only.
 *
 * ## Platform notes
 *
 * 1. **Fetch streaming.** React Native's `fetch` historically returned a null
 *    `response.body`: the runtime buffered the entire response before
 *    resolving. RN added an opt-in streaming mode — you must pass
 *    `reactNative: { textStreaming: true }` on `fetch()` init to get a real
 *    `ReadableStream`. This option is an RN-only extension to `RequestInit`
 *    and is ignored on web (so the same code path works under Expo Web).
 *
 *    Tested on Expo SDK 54 / RN 0.81 (Hermes). On older RN (<0.75) the
 *    streaming path may fall through to the non-streaming fallback below.
 *
 * 2. **Non-streaming fallback.** If `response.body` is null (RN version
 *    without streaming support, Flipper interfering, etc.) the hook falls
 *    back to `response.text()` + single-shot SSE parse. The agent's turn
 *    completes atomically — no delta rendering, but correctness preserved.
 *    Consumers see content_block_start → content_block_delta → stop in one
 *    tick. Good enough for tiny turns; a noticeable UX regression for long
 *    ones. Document this to users targeting old RN.
 *
 * 3. **TextDecoder.** Ships natively in Hermes on RN 0.74+ (SDK 50+).
 *    If targeting older RN, polyfill it in the app entry file.
 *
 * 4. **AbortController.** Available in RN 0.60+ (all supported versions).
 *
 * 5. **crypto.randomUUID.** NOT available in Hermes. We degrade to
 *    `Math.random()` — ids are internal/ephemeral, not cryptographic.
 *
 * ## Runtime caveats (untested by the porting session)
 *
 * - Android pre-RN-0.75 may need the `react-native-fetch-api` polyfill to
 *   expose `response.body`. If a real device shows the non-streaming
 *   fallback always firing, that's the likely culprit.
 * - iOS + Flipper has been known to intercept fetch and drop streaming.
 *   Disable Flipper network inspector when testing streaming locally.
 * - Expo Web uses the browser's native fetch — behaves identically to the
 *   web hook.
 *
 * @example
 * ```tsx
 * const { messages, send, isStreaming, error } = useInvoke();
 * <Pressable onPress={() => send('hi')}>
 *   <Text>Send</Text>
 * </Pressable>
 * ```
 */
import { useCallback, useRef, useState } from 'react';
import type {
  ContentBlock,
  InvokeErrorCode,
  InvokeTurn,
  ToolUseBlock,
} from '@ggui-ai/protocol';
import { useGguiContext } from '../components/GguiProvider';
import { parseSseStream } from './sse-parse';

const PROTOCOL_VERSION = '1';

/**
 * RN-specific extension to `RequestInit`. React Native's fetch accepts
 * `reactNative.textStreaming = true` to opt into a real streaming response
 * body. The option is silently ignored on other platforms (web fetch just
 * sees an unknown property), so the cast-free type below is safe across
 * Expo Web + iOS + Android.
 */
type RNRequestInit = RequestInit & {
  reactNative?: { textStreaming?: boolean };
};

export interface UseInvokeOptions {
  /** Override `appConfig.endpointUrl`. */
  endpointUrl?: string;
  /**
   * Continue an existing conversation. Absent → new session each call.
   * Forwarded to the agent as the `X-Ggui-Session-Id` header — this is
   * the conversation envelope identity (the chat thread), distinct from
   * any per-render `renderId` carried on `_meta["ai.ggui/render"]`.
   */
  hostSessionId?: string;
  /** End-user JWT for authenticated apps. */
  bearerToken?: string;
  /**
   * Seed the conversation on mount. Useful when reopening a persistent
   * thread — the seed counts toward `history` on the next `send()` so the
   * agent keeps context. Captured by `useState` once at mount; changing
   * this prop later does NOT re-seed. The caller must gate hook mount
   * until the seed is ready (ChatThreadProvider handles this in Chunk 2).
   */
  initialMessages?: ConversationMessage[];
  /**
   * Fired for every `tool_use` content block the agent emits. Protocol v1.1
   * emits two kinds of tool_use that clients care about:
   *   - `ggui_render` / `ggui_update` / `ggui_handshake` — paired by
   *     `tool_use_id` with an inline `tool_result` block on the same
   *     assistant turn. Consumers watch for the pair and mount their
   *     renderer (e.g. `<McpAppIframe>` on the web SDK) using the
   *     bootstrap metadata off the paired tool_result.
   *   - `ggui_render_blueprint` — a pure client tool (no server result to
   *     pair with); the consumer resolves the blueprint name locally.
   */
  onToolUse?: (block: ToolUseBlock) => void;
  /** Fired on terminal error frames or transport failures. */
  onError?: (err: InvokeError) => void;
  /**
   * Dev-mode bridge routing — when set, `send()` POSTs to
   * `{gatewayUrl}/{appId}` instead of `{endpointUrl}/invoke`. The pod
   * routes by `appId` and ignores `connectionId` (kept for compat).
   * Mirrors the web hook; see that JSDoc for the full description.
   * When set, `endpointUrl` is optional — the gateway is the transport.
   */
  devBridge?: {
    /** Base URL of the bridge gateway (trailing slash optional). */
    gatewayUrl: string;
    /** @deprecated Ignored by the bridge-gateway pod — routes by appId. */
    connectionId?: string;
  };
  /**
   * Fires once per `send()` with the streaming mode that was used.
   * Device testers on Android use this to confirm `response.body`
   * actually returns a `ReadableStream` (mode `'streaming'`) vs
   * silently degrading to the buffered fallback (mode `'buffered'`).
   * Web hooks don't need this — ReadableStream is reliable there.
   */
  onStreamMode?: (mode: 'streaming' | 'buffered') => void;
}

export interface InvokeError {
  code: InvokeErrorCode | 'transport_error';
  message: string;
  retryAfterMs?: number;
}

export interface ConversationMessage {
  /** Stable id — for assistants this is the agent's `message.id`. */
  id: string;
  role: 'user' | 'assistant';
  /** Accumulated content blocks. Assistant blocks fill in over time. */
  content: ContentBlock[];
  /** True while assistant blocks are still receiving deltas. */
  isStreaming: boolean;
}

export interface UseInvokeReturn {
  messages: ConversationMessage[];
  /**
   * Send a user message; resolves when the assistant turn completes (or errors).
   * Accepts an optional `clientMessageId` so callers with durable storage can
   * own the user-message id and achieve outbox idempotency across retries.
   */
  send: (message: string, opts?: { clientMessageId?: string }) => Promise<void>;
  /** True between `send()` start and turn completion. */
  isStreaming: boolean;
  /** Most recent error; reset on next `send()`. */
  error: InvokeError | null;
  /** Abort the in-flight turn. Closes the fetch + drops streaming flags. */
  abort: () => void;
  /** Reset the local conversation. Does NOT affect server-side state. */
  reset: () => void;
}

export function useInvoke(options: UseInvokeOptions = {}): UseInvokeReturn {
  const ctx = useGguiContext();
  const endpointUrl = options.endpointUrl ?? ctx.appConfig?.endpointUrl;

  const [messages, setMessages] = useState<ConversationMessage[]>(
    options.initialMessages ?? [],
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<InvokeError | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Always-current snapshot for building `history` without re-creating `send`.
  const messagesRef = useRef<ConversationMessage[]>(messages);
  messagesRef.current = messages;
  // Tracks the hostSessionId the agent surfaces via `tool_result` on turn 1
  // so subsequent `send()` calls can carry `X-Ggui-Session-Id` — without
  // this the agent mints a new session per POST and turn-2 render events
  // never reach the already-mounted `<GguiRender>`. Mirrors the web hook's
  // fix. Names the conversation envelope (the chat thread), distinct from
  // any per-render `renderId`.
  const hostSessionIdRef = useRef<string | null>(options.hostSessionId ?? null);

  const send = useCallback(
    async (message: string, opts?: { clientMessageId?: string }): Promise<void> => {
      // devBridge short-circuits the prod endpoint — gateway is the transport.
      if (!endpointUrl && !options.devBridge) {
        const err: InvokeError = {
          code: 'invalid_request',
          message: 'Cannot invoke: neither app.endpointUrl nor devBridge is configured.',
        };
        setError(err);
        options.onError?.(err);
        return;
      }
      if (abortRef.current) {
        // Refuse overlapping sends — caller decides whether to abort first.
        return;
      }

      setError(null);
      const controller = new AbortController();
      abortRef.current = controller;

      // Append user message + placeholder assistant message in one update.
      // `clientMessageId` lets durable callers own the user id so retries
      // dedupe at the outbox level instead of creating duplicates.
      const userId = opts?.clientMessageId ?? `user_${cryptoRandom()}`;
      const assistantId = `asst_${cryptoRandom()}`;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: 'user', content: [{ type: 'text', text: message }], isStreaming: false },
        { id: assistantId, role: 'assistant', content: [], isStreaming: true },
      ]);
      setIsStreaming(true);

      // Build history from the snapshot BEFORE this turn (excludes the user
      // message we just appended, since `message` carries it explicitly).
      const history = toInvokeHistory(messagesRef.current);

      // Track the assistant message id across the turn — message_start may
      // rename it from `assistantId` to the agent-supplied `message.id`,
      // and the catch/finally block needs to find it whichever id it has.
      let assistantMsgId = assistantId;

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'X-Ggui-Protocol-Version': PROTOCOL_VERSION,
          'X-Ggui-App-Id': ctx.appId,
        };
        // options.hostSessionId wins for explicit-resume callers; otherwise
        // fall back to the hostSessionId surfaced on a prior turn's
        // tool_result. The wire header name stays `X-Ggui-Session-Id` —
        // the option just gets a clearer name on the SDK surface.
        const effectiveHostSessionId = options.hostSessionId ?? hostSessionIdRef.current;
        if (effectiveHostSessionId) headers['X-Ggui-Session-Id'] = effectiveHostSessionId;
        if (options.bearerToken) headers['Authorization'] = `Bearer ${options.bearerToken}`;

        const init: RNRequestInit = {
          method: 'POST',
          headers,
          body: JSON.stringify({ message, history }),
          signal: controller.signal,
          // RN-only: opt into real streaming body. Silently ignored on web.
          reactNative: { textStreaming: true },
        };

        // Dev-mode bridge: gateway receives `{gatewayUrl}/{appId}?bridgeConnectionId={connId}`
        // POSTs and streams the SSE response from the local `ggui dev` CLI.
        const targetUrl = options.devBridge
          ? `${options.devBridge.gatewayUrl.replace(/\/$/, '')}/${encodeURIComponent(ctx.appId)}${options.devBridge.connectionId ? `?bridgeConnectionId=${encodeURIComponent(options.devBridge.connectionId)}` : ''}`
          : `${(endpointUrl as string).replace(/\/$/, '')}/invoke`;
        const response = await fetch(targetUrl, init);

        if (!response.ok) {
          let payload: { error?: { code?: InvokeErrorCode; message?: string; retryAfterMs?: number } } = {};
          try {
            payload = (await response.json()) as typeof payload;
          } catch {
            // non-JSON error body
          }
          const err: InvokeError = {
            code: payload.error?.code ?? 'transport_error',
            message: payload.error?.message ?? `HTTP ${response.status}`,
            ...(payload.error?.retryAfterMs !== undefined ? { retryAfterMs: payload.error.retryAfterMs } : {}),
          };
          throw err;
        }

        // Stream events. If response.body is null (older RN, Flipper, no
        // streaming support) fall back to buffered text parse — same frames,
        // all arrive at once. Correctness preserved, streaming UX lost.
        // Fire `onStreamMode` so device testers can verify which path the
        // platform actually took (the buffered path is indistinguishable
        // from a fast stream without explicit signalling).
        const usingStreaming = response.body != null;
        options.onStreamMode?.(usingStreaming ? 'streaming' : 'buffered');
        const events = usingStreaming
          ? parseSseStream(response.body as unknown as ReadableStream<Uint8Array>, controller.signal)
          : bufferedFallback(await response.text());

        for await (const event of events) {
          if (controller.signal.aborted) break;
          if (event.type === 'message_start') {
            // Adopt the agent's message id so client + server line up.
            const newId = event.message.id;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, id: newId } : m)),
            );
            assistantMsgId = newId;
            continue;
          }
          if (event.type === 'content_block_start') {
            const block = event.content_block;
            setMessages((prev) =>
              mutateAssistant(prev, assistantMsgId, (m) => ({
                ...m,
                content: setBlockAt(m.content, event.index, block),
              })),
            );
            if (block.type === 'tool_use') {
              options.onToolUse?.(block);
            }
            // Snap hostSessionId off the first tool_result that surfaces
            // one — agent-side tools like `ggui_render` / `ggui_handshake`
            // inline their result on the same assistant turn with a
            // sessionId payload (the conversation envelope identity, not
            // a per-render id). Subsequent sends reuse this so the server
            // threads user messages to the same session instead of minting
            // a new one per POST.
            if (block.type === 'tool_result' && !hostSessionIdRef.current) {
              const maybe = extractHostSessionIdFromContent(block.content);
              if (maybe) hostSessionIdRef.current = maybe;
            }
            continue;
          }
          if (event.type === 'content_block_delta') {
            const { index, delta } = event;
            setMessages((prev) =>
              mutateAssistant(prev, assistantMsgId, (m) => ({
                ...m,
                content: applyDelta(m.content, index, delta),
              })),
            );
            continue;
          }
          if (event.type === 'error') {
            const err: InvokeError = {
              code: event.error.code,
              message: event.error.message,
              ...(event.error.retryAfterMs !== undefined ? { retryAfterMs: event.error.retryAfterMs } : {}),
            };
            throw err;
          }
          // content_block_stop, message_delta, ping, message_stop — no UI change.
        }

        // Stream ended cleanly.
        setMessages((prev) =>
          mutateAssistant(prev, assistantMsgId, (m) => ({ ...m, isStreaming: false })),
        );
      } catch (raw) {
        const err: InvokeError = isInvokeError(raw)
          ? raw
          : makeTransportError(raw instanceof Error ? raw.message : 'Invoke failed');
        setError(err);
        options.onError?.(err);
        // Mark assistant message done (even if empty) so UI doesn't spin.
        setMessages((prev) =>
          mutateAssistant(prev, assistantMsgId, (m) => ({ ...m, isStreaming: false })),
        );
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
      }
    },
    [endpointUrl, ctx.appId, options],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    // Clear the derived hostSessionId — reset() implies a fresh conversation.
    hostSessionIdRef.current = options.hostSessionId ?? null;
  }, [options.hostSessionId]);

  return { messages, send, isStreaming, error, abort, reset };
}

// ── Helpers ───────────────────────────────────────────────────────────

function cryptoRandom(): string {
  // Hermes ships `crypto.getRandomValues` but NOT `crypto.randomUUID` as of
  // RN 0.81. We only need a short unique id for client-side message keying,
  // so Math.random is acceptable (not cryptographic).
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

function isInvokeError(value: unknown): value is InvokeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as { code: unknown }).code === 'string'
  );
}

function makeTransportError(message: string): InvokeError {
  return { code: 'transport_error', message };
}

/**
 * Pull a `sessionId` string (the conversation envelope = hostSessionId)
 * out of a tool_result's content payload if one is present. Tolerant of
 * arbitrary nested shapes — agents may put the id directly on the result
 * or under a wrapper like `{ result: { sessionId } }`. The field on the
 * wire is still spelled `sessionId` (agent-side payload contract); the
 * SDK-side name `hostSessionId` clarifies the role.
 */
function extractHostSessionIdFromContent(content: unknown): string | null {
  if (typeof content !== 'object' || content === null) return null;
  const record = content as Record<string, unknown>;
  if (typeof record.sessionId === 'string') return record.sessionId;
  // One level of nesting — common when tools wrap their output in `{ result }`.
  for (const value of Object.values(record)) {
    if (typeof value === 'object' && value !== null) {
      const inner = value as Record<string, unknown>;
      if (typeof inner.sessionId === 'string') return inner.sessionId;
    }
  }
  return null;
}

function mutateAssistant(
  messages: ConversationMessage[],
  id: string,
  fn: (m: ConversationMessage) => ConversationMessage,
): ConversationMessage[] {
  return messages.map((m) => (m.id === id && m.role === 'assistant' ? fn(m) : m));
}

function setBlockAt(blocks: ContentBlock[], index: number, block: ContentBlock): ContentBlock[] {
  const next = blocks.slice();
  // Pad with text placeholders if the agent skipped indices (defensive).
  while (next.length < index) next.push({ type: 'text', text: '' });
  next[index] = block;
  return next;
}

function applyDelta(
  blocks: ContentBlock[],
  index: number,
  delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string },
): ContentBlock[] {
  const target = blocks[index];
  if (!target) return blocks;
  if (delta.type === 'text_delta' && target.type === 'text') {
    const next = blocks.slice();
    next[index] = { ...target, text: target.text + delta.text };
    return next;
  }
  // input_json_delta accumulation isn't surfaced to UI in v1 — agents that
  // need this can opt in via a future hook. Drop silently.
  return blocks;
}

/**
 * Project the local conversation into the wire `InvokeTurn[]` shape the
 * server expects on `history`. Strip in-flight assistant messages — they
 * have no final stop_reason.
 */
function toInvokeHistory(messages: ConversationMessage[]): InvokeTurn[] {
  return messages
    .filter((m) => !(m.role === 'assistant' && m.isStreaming))
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Fallback when `response.body` is null (no streaming support in this RN
 * environment). Parses the entire buffered SSE payload and yields events
 * one-by-one from memory. Consumers still see normal event-by-event state
 * updates — just all in the same tick instead of interleaved with network.
 *
 * Splits frames on the SSE separator (`\n\n`), strips the `data: ` prefix,
 * JSON-parses + validates each frame via the same schema the streaming path
 * uses. Silently drops malformed frames — same policy as `parseSseStream`.
 */
async function* bufferedFallback(
  payload: string,
): AsyncGenerator<import('@ggui-ai/protocol').InvokeEvent> {
  const { invokeEventSchema } = await import('@ggui-ai/protocol');
  const FRAME_SEP = '\n\n';
  const frames = payload.split(FRAME_SEP);
  for (const frame of frames) {
    const dataIdx = frame.indexOf('data: ');
    if (dataIdx === -1) continue;
    const json = frame.slice(dataIdx + 'data: '.length).trim();
    if (!json) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    const result = invokeEventSchema.safeParse(parsed);
    if (result.success) yield result.data;
  }
}
