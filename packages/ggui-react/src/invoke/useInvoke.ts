/**
 * useInvoke — React hook for the streamable invoke protocol (v1).
 *
 * POSTs the user's message + history to `{endpointUrl}/invoke`, reads the
 * SSE response, accumulates assistant content blocks in real time, and
 * exposes a stateless conversation suitable for ChatShell to render.
 *
 * Stateless agent semantics: client owns history, sends full `history[]`
 * on every turn (mirrors the Anthropic Messages API).
 *
 * @example
 * ```tsx
 * const { messages, send, isStreaming, error } = useInvoke();
 * <button onClick={() => send('hi')}>Send</button>
 * {messages.map((m) => <Message key={m.id} {...m} />)}
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

export interface UseInvokeOptions {
  /** Override `appConfig.endpointUrl`. */
  endpointUrl?: string;
  /** Continue an existing conversation. Absent → new session each call. */
  sessionId?: string;
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
   *   - `ggui_push` / `ggui_update` / `ggui_handshake` — paired by
   *     `tool_use_id` with an inline `tool_result` block on the same
   *     assistant turn. Servers built on `@ggui-ai/server` emit these via
   *     `stream.toolResultPush(id, bootstrap)` so the result's
   *     `content._meta.ggui.bootstrap` carries the MCP-Apps-shaped
   *     connection material (`wsUrl` / `token` / `expiresAt` /
   *     `sessionId` / `appId` / `runtimeUrl` / optional `adapters`) —
   *     the exact shape `@ggui-ai/protocol/integrations/mcp-apps`
   *     defines as `PushResultMeta`. Consumers watch for the pair and
   *     mount `<McpAppIframe>` using `extractBootstrapMeta(content)`
   *     (exported from this module) to pull the bootstrap off the
   *     result — NOT by reading a plain `sessionId` field.
   *   - `ggui_render_blueprint` — a pure client tool (no server result to
   *     pair with); the consumer resolves the blueprint name locally.
   * ChatShell wires both patterns internally; callers who build their own
   * UI register their own handler.
   */
  onToolUse?: (block: ToolUseBlock) => void;
  /** Fired on terminal error frames or transport failures. */
  onError?: (err: InvokeError) => void;
  /**
   * Dev-mode bridge routing — when set, `send()` POSTs to
   * `{gatewayUrl}/{appId}` instead of `{endpointUrl}/invoke`. The
   * bridge-gateway pod forwards the request (and its SSE response) to
   * whichever `ggui dev` CLI process is holding the matching WebSocket
   * connection for this `appId`. Source of `gatewayUrl` is
   * `amplify_outputs.custom.bridgeGatewayUrl` (pod HTTP ingress at
   * `https://mcp.<apex>/bridge`).
   *
   * When `devBridge` is set, `endpointUrl` is optional — the gateway is
   * the transport.
   *
   * `connectionId` is legacy (pre-Path-B the Lambda needed it to target a
   * specific WS connection). The pod routes by `appId` and ignores the
   * `bridgeConnectionId` query param; the field stays for backward
   * compatibility with callers that still plumb it through.
   */
  devBridge?: {
    /** Base URL of the bridge gateway (trailing slash optional). */
    gatewayUrl: string;
    /** @deprecated Ignored by the bridge-gateway pod — routes by appId. */
    connectionId?: string;
  };
  /**
   * Optional callback fired once per `send()` when the response transport
   * shape is known. Mirrors the RN SDK's option so the two signatures align
   * at the facade level.
   *
   *   'streaming' — fetch returned a ReadableStream (SSE path)
   *   'buffered'  — degraded to buffered response (RN-only in practice;
   *                 web fetch always streams when `response.body` is present)
   *
   * Web's fetch almost always returns a stream; callers who don't need the
   * signal can omit the option.
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
  // Tracks the sessionId the agent surfaces via `tool_result` on turn 1 so
  // subsequent `send()` calls can carry `X-Ggui-Session-Id` — without this
  // the agent mints a new session per POST and turn-2 render events never
  // reach the already-mounted `<GguiSession>`. `options.sessionId` wins for
  // explicit-resume callers; the ref populates on stream receipt otherwise.
  const sessionIdRef = useRef<string | null>(options.sessionId ?? null);

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
        // options.sessionId wins for explicit-resume callers; otherwise
        // fall back to the sessionId surfaced on a prior turn's tool_result.
        const effectiveSessionId = options.sessionId ?? sessionIdRef.current;
        if (effectiveSessionId) headers['X-Ggui-Session-Id'] = effectiveSessionId;
        if (options.bearerToken) headers['Authorization'] = `Bearer ${options.bearerToken}`;

        // Dev-mode bridge: the pod expects POSTs at `{gatewayUrl}/{appId}` —
        // it looks up the `ggui dev` CLI's WS by appId and streams the SSE
        // response from whatever replies. `connectionId` (if provided) is
        // appended as a best-effort hint and ignored by the pod.
        // Prod path is the standard `{endpointUrl}/invoke`.
        const targetUrl = options.devBridge
          ? `${options.devBridge.gatewayUrl.replace(/\/$/, '')}/${encodeURIComponent(ctx.appId)}${options.devBridge.connectionId ? `?bridgeConnectionId=${encodeURIComponent(options.devBridge.connectionId)}` : ''}`
          : `${(endpointUrl as string).replace(/\/$/, '')}/invoke`;
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message, history }),
          signal: controller.signal,
        });

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

        if (!response.body) {
          throw makeTransportError('Response body is empty');
        }

        // Signal which transport shape the runtime resolved to. Web always
        // takes the streaming path when response.body is present (we threw
        // above otherwise). Fire-and-forget.
        options.onStreamMode?.('streaming');

        for await (const event of parseSseStream(response.body, controller.signal)) {
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
            // Snap sessionId off the first tool_result that surfaces one —
            // agent-side tools like `ggui_push` / `ggui_handshake` inline
            // their result on the same assistant turn with a sessionId
            // payload. Subsequent sends reuse this so the server threads
            // user messages to the same session instead of minting a new
            // one per POST.
            if (block.type === 'tool_result' && !sessionIdRef.current) {
              const maybe = extractSessionIdFromContent(block.content);
              if (maybe) sessionIdRef.current = maybe;
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
    // Clear the derived sessionId — reset() implies a fresh conversation.
    // Explicit-resume callers pass options.sessionId on the next render,
    // which re-seeds the ref via the component re-mount cycle.
    sessionIdRef.current = options.sessionId ?? null;
  }, [options.sessionId]);

  return { messages, send, isStreaming, error, abort, reset };
}

// ── Helpers ───────────────────────────────────────────────────────────

function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().slice(0, 8);
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
 * Pull a `sessionId` string out of a tool_result's content payload if one
 * is present. Tolerant of arbitrary nested shapes — agents may put the id
 * directly on the result or under a wrapper like `{ result: { sessionId } }`.
 */
function extractSessionIdFromContent(content: unknown): string | null {
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
