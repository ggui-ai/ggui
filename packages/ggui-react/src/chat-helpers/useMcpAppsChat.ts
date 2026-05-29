/* eslint-disable no-console */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GguiUserActionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  ChatEntry,
  HostDisplayMode,
  RenderRef,
  ToolCallEntry,
} from './mcp-apps-chat-types';

/**
 * Public options for {@link useMcpAppsChat}.
 *
 * Sample apps wire the hook against their own agent backend; the hook
 * itself knows nothing about which LLM SDK is driving the loop. All
 * agent-shape knowledge is encapsulated in the
 * `SDK-message-stream → ChatEntry[]` mapping below, which is identical
 * across Claude Agent SDK / OpenAI Agents SDK / Google ADK because each
 * has been normalised to the same `tool_use` / `tool_use_result` / text
 * SDK-message shape on the way out of the agent process.
 */
export interface UseMcpAppsChatOptions {
  /**
   * POST endpoint for sending a new prompt. The hook opens an SSE
   * stream from this URL and feeds every `event: message\ndata: <json>`
   * frame through the internal SDK-message handler.
   *
   * Backed by `@ggui-ai/agent-server`'s `POST /agent` route by
   * default; any spec-compliant endpoint that returns SSE with
   * `event: chat-allocated` (first) + `event: message` frames will
   * work.
   */
  readonly chatEndpoint: string;
  /**
   * GET endpoint for the server-authoritative chat snapshot. Called
   * once on mount with `?chatId=<id>`. Returns `{messages, renders}` —
   * `messages` are SDK messages (replayed through the same handler the
   * live SSE stream uses), `renders` are optional descriptors for any
   * MCP-Apps resource whose URI didn't ride inline on a recorded
   * SDKMessage. Defaults to the same URL as {@link chatEndpoint}.
   *
   * Returning 404 = "fresh chatId" → empty conversation. Returning a
   * non-404 error logs a warning and the chat boots blank.
   */
  readonly snapshotEndpoint?: string;
  /**
   * Stable per-conversation chat id, when one is known (e.g. user
   * loaded the URL `?chat=<id>` for a previously-visited chat).
   * Forwarded as the request body's `chatId` field on every POST so
   * the server keys per-chat snapshot + resume state by the same
   * value.
   *
   * Pass `undefined` for a fresh conversation — the server allocates
   * an id and surfaces it via the SSE `chat-allocated` event; the
   * host then writes it to URL / localStorage in
   * {@link onChatAllocated}. The hook never mints client-side.
   */
  readonly chatId?: string;
  /**
   * Fires when the server allocates a fresh chat id on the first
   * POST that didn't carry one. Host apps stamp the id into URL /
   * localStorage here so the next reload rehydrates the same
   * conversation.
   *
   * Not called when {@link chatId} is supplied (no allocation
   * happens — the server uses the supplied id directly).
   */
  readonly onChatAllocated?: (chatId: string) => void;
  /**
   * Resolve the bearer token the hook should send on every request
   * as `Authorization: Bearer <token>`. Called per fetch so the host
   * can refresh or rotate tokens transparently. Return `undefined`
   * (or omit the option) to send no Authorization header.
   *
   * Pairs with `@ggui-ai/agent-server`'s default
   * `createGuestTokenAuth()` adapter — see the package README for
   * the client-side guest-token flow (POST /auth/guest → store
   * token → pass through this callback).
   */
  readonly getAuthToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * Optional hook for 401 responses. Lets the host re-mint a guest
   * token, update its store, and retry the request once. Return
   * `true` to signal "I refreshed; retry"; return `false` to give
   * up and surface the error to the chat panel.
   *
   * Called once per failed request — re-failure on retry surfaces as
   * a normal error without another retry attempt.
   */
  readonly onUnauthenticated?: () => boolean | Promise<boolean>;
}

/**
 * Public return of {@link useMcpAppsChat}.
 *
 * `entries[]` is the render-ready chat log; `renders[]` is every
 * MCP-Apps resource the agent has produced this conversation (latest at
 * the end). Sample chat panels render `entries` inline and pass
 * `renders[i]` to `<AppRenderer toolResourceUri={...}>` for iframe
 * mounting.
 */
export interface UseMcpAppsChatResult {
  readonly entries: ReadonlyArray<ChatEntry>;
  readonly renders: ReadonlyArray<RenderRef>;
  /**
   * Most-recent host-side presentation hint stamped on a render, or
   * `undefined` when no render has yet carried one. Drives apps that
   * want to auto-switch their layout between inline / panel / pip in
   * response to `_meta.ui.displayMode` (MCP-Apps SEP-1865).
   */
  readonly hostDisplayMode: HostDisplayMode | undefined;
  readonly sending: boolean;
  /**
   * Post a fresh user prompt. Trimmed empty strings are no-ops. Opens
   * an SSE stream to the chat endpoint and merges every frame.
   *
   * Optional `opts.userAction` is the spec-canonical
   * `_meta["ai.ggui/userAction"]` slice (stamped by iframe-runtime
   * when a gesture must reach the agent via `ui/message`). When
   * present, the hook forwards the slice verbatim as
   * `data.meta["ai.ggui/userAction"]` in the POST body — the
   * agent-server library synthesizes the LLM-facing directive
   * prompt server-side so every ggui-coupled formatting lives in
   * one place across SDKs.
   */
  readonly send: (
    prompt: string,
    opts?: { readonly userAction?: GguiUserActionMeta },
  ) => Promise<void>;
  /**
   * Abort the in-flight stream. Cancels the `fetch` via its
   * AbortController, which propagates as a network-level abort on the
   * server (SSE write loop sees the broken pipe and unwinds the agent
   * call). No-op when nothing is in flight.
   */
  readonly abort: () => void;
}

/**
 * Brand-neutral hook for chat shells that drive an MCP-Apps-spec agent
 * backend and want to mount MCP-Apps resources inline.
 *
 * The hook walks the SDK message stream and, for every `tool_result`
 * block, extracts the MCP-Apps standard `_meta.ui.resourceUri` (or the
 * legacy flat `_meta['ui/resourceUri']` form). Each unique resourceUri
 * becomes one {@link RenderRef} — dedupe is by URI alone, so re-emits
 * of the same URI (after server-side state mutations such as a
 * `*_update` tool call) coalesce onto the same iframe entry. The host
 * mounts the iframe by passing `resourceUri` to
 * `<AppRenderer toolResourceUri={...}>` plus an `onReadResource`
 * callback that proxies the read via the agent backend's relay.
 *
 * No vendor-specific knowledge: the hook does not parse any non-spec
 * extension key, doesn't poll a custom state endpoint, doesn't
 * discriminate between "create" and "update" tool calls. The
 * server-rendered HTML (returned by `resources/read`) handles its own
 * live-update channel (e.g. a WebSocket the server bakes into the
 * shell). When the iframe re-mounts (rehydrate after navigation), the
 * next `resources/read` returns the current server-authoritative HTML
 * — staleness is impossible by construction.
 *
 * `_meta.ui.displayMode` is the only non-resourceUri spec field the
 * hook surfaces — exposed as {@link hostDisplayMode} for layout
 * auto-switch per MCP-Apps SEP-1865.
 */
export function useMcpAppsChat(
  opts: UseMcpAppsChatOptions,
): UseMcpAppsChatResult {
  const {
    chatEndpoint,
    chatId,
    snapshotEndpoint = chatEndpoint,
    onChatAllocated,
    getAuthToken,
    onUnauthenticated,
  } = opts;

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [renders, setRenders] = useState<RenderRef[]>([]);
  const [hostDisplayMode, setHostDisplayMode] = useState<
    HostDisplayMode | undefined
  >(undefined);
  const [sending, setSending] = useState(false);
  // AbortController for the in-flight chat stream. Replaced on every
  // `send`; consumed by `abort`. Ref (not state) because abort is fire-
  // and-forget — no re-render needed when it changes.
  const abortControllerRef = useRef<AbortController | null>(null);
  // Latest `onChatAllocated` callback. Ref-pinned so the stable
  // `send` callback below sees fresh closure values without retaking
  // its identity (avoiding remount cascades on the consumer side).
  const onChatAllocatedRef = useRef(onChatAllocated);
  onChatAllocatedRef.current = onChatAllocated;
  const getAuthTokenRef = useRef(getAuthToken);
  getAuthTokenRef.current = getAuthToken;
  const onUnauthenticatedRef = useRef(onUnauthenticated);
  onUnauthenticatedRef.current = onUnauthenticated;

  const append = useCallback((entry: ChatEntry) => {
    setEntries((prev) => [...prev, entry]);
  }, []);

  /**
   * Patch a tool-call entry by id (Anthropic's `tool_use_id` or the
   * SDK's equivalent unique per-call id). Used when the matching
   * `tool_result` block lands on a later SSE frame — we locate the
   * existing entry and merge the result/isError fields. No-ops when
   * the entry doesn't exist (out-of-order delivery; rare).
   */
  const patchToolCall = useCallback(
    (
      toolUseId: string,
      patch: { readonly result?: unknown; readonly isError?: boolean },
    ) => {
      setEntries((prev) => {
        const idx = prev.findIndex(
          (e) => e.kind === 'tool-call' && e.toolUseId === toolUseId,
        );
        if (idx < 0) return prev;
        const next = prev.slice();
        const existing = next[idx] as ToolCallEntry;
        next[idx] = { ...existing, ...patch };
        return next;
      });
    },
    [],
  );

  const addRender = useCallback((item: RenderRef) => {
    setRenders((prev) => {
      // Dedupe by resourceUri — re-emits (e.g. *_update returning the
      // same URI) land on the same bucket rather than spawning a new
      // iframe each time. The iframe stays mounted; live updates flow
      // through whichever channel the server-rendered HTML wired up
      // (typically a WebSocket baked into the shell).
      if (prev.some((p) => p.resourceUri === item.resourceUri)) return prev;
      return [...prev, item];
    });
  }, []);

  const send = useCallback(
    async (
      prompt: string,
      sendOpts?: { readonly userAction?: GguiUserActionMeta },
    ) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const turnId = mintTurnId();
      // Chat panel shows the user's verbatim prose — the
      // [GGUI_USER_ACTION] directive synthesis below only changes
      // what crosses the wire to the agent, never what the user
      // sees in their own message bubble.
      append({ id: `${turnId}.user`, kind: 'user', text: trimmed });
      setSending(true);
      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        // Forward the spec-canonical `_meta.ai.ggui/userAction` slice
        // verbatim in `data.meta` when present. The agent-server
        // library synthesizes the imperative-first LLM directive
        // server-side — one place across SDKs, no client-side prose
        // formatting.
        const body: {
          prompt: string;
          chatId?: string;
          data?: { meta?: { 'ai.ggui/userAction': GguiUserActionMeta } };
        } = { prompt: trimmed };
        if (chatId !== undefined && chatId.length > 0) {
          body.chatId = chatId;
        }
        if (sendOpts?.userAction !== undefined) {
          body.data = {
            meta: { 'ai.ggui/userAction': sendOpts.userAction },
          };
        }
        const doFetch = async (): Promise<Response> => {
          const token = await Promise.resolve(getAuthTokenRef.current?.());
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (typeof token === 'string' && token.length > 0) {
            headers.Authorization = `Bearer ${token}`;
          }
          return fetch(chatEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        };
        let res = await doFetch();
        if (res.status === 401 && onUnauthenticatedRef.current) {
          const refreshed = await Promise.resolve(
            onUnauthenticatedRef.current(),
          );
          if (refreshed) {
            res = await doFetch();
          }
        }
        if (!res.body) {
          append({
            id: `${turnId}.err`,
            kind: 'error',
            text: 'Server returned no body.',
          });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let counter = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const raw of events) {
            if (!raw.trim()) continue;
            const lines = raw.split('\n');
            let eventType = 'message';
            let data = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) eventType = line.slice(7);
              else if (line.startsWith('data: ')) data = line.slice(6);
            }
            if (!data) continue;
            let payload: unknown;
            try {
              payload = JSON.parse(data);
            } catch {
              continue;
            }
            // Server-allocated chat id — emitted as the first SSE
            // event on every POST. Host stamps it into URL /
            // localStorage so the next reload rehydrates the same
            // conversation. Don't echo to the chat panel.
            if (eventType === 'chat-allocated') {
              const allocated = (payload as { chatId?: unknown }).chatId;
              if (typeof allocated === 'string' && allocated.length > 0) {
                onChatAllocatedRef.current?.(allocated);
              }
              continue;
            }
            counter += 1;
            handleEvent(eventType, payload, `${turnId}.${counter}`, {
              append,
              addRender,
              setHostDisplayMode,
              patchToolCall,
            });
          }
        }
      } catch (err) {
        // AbortError on user-initiated stop is expected — show a calm
        // marker, not a red error. Other errors fall through to the
        // existing error renderer.
        if (err instanceof DOMException && err.name === 'AbortError') {
          append({ id: `${turnId}.stop`, kind: 'end', subtype: 'aborted' });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          append({ id: `${turnId}.err`, kind: 'error', text: message });
        }
      } finally {
        abortControllerRef.current = null;
        setSending(false);
      }
    },
    [append, addRender, chatEndpoint, chatId, patchToolCall],
  );

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // On-mount rehydration. When the host provides a chatId for a
  // previously-visited conversation, pull the server-authoritative
  // snapshot and re-feed it through the same `handleEvent` pipeline the
  // live SSE stream uses. The server holds the SDK message stream
  // verbatim, so replaying them rebuilds the chat panel AND remounts
  // iframes by their resourceUri (the next `resources/read` returns
  // current server-authoritative HTML — staleness is impossible).
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    void (async () => {
      try {
        const buildHeaders = async (): Promise<Record<string, string>> => {
          const headers: Record<string, string> = {
            Accept: 'application/json',
          };
          const token = await Promise.resolve(getAuthTokenRef.current?.());
          if (typeof token === 'string' && token.length > 0) {
            headers.Authorization = `Bearer ${token}`;
          }
          return headers;
        };
        let res = await fetch(
          `${snapshotEndpoint}?chatId=${encodeURIComponent(chatId)}`,
          { headers: await buildHeaders() },
        );
        if (res.status === 401 && onUnauthenticatedRef.current) {
          const refreshed = await Promise.resolve(
            onUnauthenticatedRef.current(),
          );
          if (refreshed) {
            res = await fetch(
              `${snapshotEndpoint}?chatId=${encodeURIComponent(chatId)}`,
              { headers: await buildHeaders() },
            );
          }
        }
        // 404 = fresh chatId — no prior snapshot. Ignore silently so the
        // React tree boots into an empty conversation.
        if (res.status === 404 || cancelled) return;
        if (!res.ok) {
          console.warn('[useMcpAppsChat] GET snapshot non-2xx', res.status);
          return;
        }
        const body = (await res.json()) as ChatSnapshotResponse;
        let counter = 0;
        for (const msg of body.messages ?? []) {
          if (cancelled) return;
          counter += 1;
          handleEvent('message', msg, `restored.${counter}`, {
            append,
            addRender,
            setHostDisplayMode,
            patchToolCall,
          });
        }
        // Mount any explicitly-restored resource URIs (defensive — the
        // replay above already mounts every iframe whose tool_result
        // carried `_meta.ui.resourceUri`). Dedupes by resourceUri via
        // addRender.
        for (const entry of body.renders ?? []) {
          if (cancelled) return;
          if (typeof entry.resourceUri !== 'string' || entry.resourceUri.length === 0) {
            continue;
          }
          addRender({
            resourceUri: entry.resourceUri,
            action: entry.action ?? 'restored',
            ...(entry.toolUseId !== undefined
              ? { toolUseId: entry.toolUseId }
              : {}),
          });
        }
      } catch (err) {
        console.warn('[useMcpAppsChat] GET snapshot failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // chatId is stable for the page lifetime (host owns minting).
    // Intentionally omitting append/addRender/etc. from deps — they're
    // stable useCallback refs and the cancellation flag prevents any
    // double-fire if the IDs ever change identity.
  }, [chatId, snapshotEndpoint, append, addRender, patchToolCall]);

  return { entries, renders, hostDisplayMode, sending, send, abort };
}

/**
 * Per-call internal dispatcher dependencies. Plain object instead of
 * positional args so the call site stays readable and adding a new hook
 * (e.g. progress events) doesn't widen the signature.
 */
interface HandleEventDeps {
  readonly append: (e: ChatEntry) => void;
  readonly addRender: (r: RenderRef) => void;
  readonly setHostDisplayMode: (mode: HostDisplayMode | undefined) => void;
  readonly patchToolCall: (
    toolUseId: string,
    patch: { readonly result?: unknown; readonly isError?: boolean },
  ) => void;
}

/**
 * Internal SDK-message walker. Exported (named `handleEvent`) for unit
 * tests that need to assert the spec-canonical `_meta.ui.{displayMode,
 * resourceUri}` extraction without spinning up an SSE round trip. Not
 * part of the public hook API — production callers go through
 * {@link useMcpAppsChat}.
 *
 * @internal
 */
export function handleEvent(
  eventType: string,
  payload: unknown,
  baseId: string,
  deps: HandleEventDeps,
): void {
  const { append, addRender, setHostDisplayMode, patchToolCall } = deps;
  if (eventType === 'error') {
    const err = (payload as { error?: string }).error ?? 'Unknown error';
    append({ id: baseId, kind: 'error', text: err });
    return;
  }
  const msg = payload as {
    type?: string;
    subtype?: string;
    message?: unknown;
  };
  if (msg.type === 'assistant') {
    const content = ((msg.message as { content?: unknown[] })?.content ??
      []) as Array<Record<string, unknown>>;
    let i = 0;
    for (const block of content) {
      i += 1;
      if (block.type === 'text' && typeof block.text === 'string') {
        append({
          id: `${baseId}.t${i}`,
          kind: 'assistant',
          text: block.text,
        });
      } else if (block.type === 'tool_use') {
        const toolUseId = String(block.id ?? `${baseId}.u${i}`);
        append({
          id: toolUseId,
          kind: 'tool-call',
          toolUseId,
          name: String(block.name ?? ''),
          input: block.input,
        });
      }
    }
    return;
  }
  if (msg.type === 'user') {
    // tool_result replay — the agent SDK forwards every tool's result
    // as a user-role message after the tool call returns. We (a) attach
    // the result to the matching tool-call entry via toolUseId so the
    // expand UI shows full call+result side-by-side, and (b) extract
    // the spec-canonical `_meta.ui.resourceUri` and either mount a new
    // iframe entry or dedupe onto an already-mounted one.
    //
    // KEY INSIGHT: Anthropic Agent SDK (and equivalents) preserve the
    // FULL original MCP tool result on `tool_use_result` (sibling of
    // `message`), even though `message.content` is stripped to
    // Anthropic-API-spec-compliant blocks (no structuredContent, no
    // _meta). This is the ONLY place we can read the standard
    // `_meta.ui.resourceUri` extension.
    const fullToolResult = (payload as { tool_use_result?: unknown })
      .tool_use_result;
    const sc: Record<string, unknown> | undefined =
      fullToolResult && typeof fullToolResult === 'object'
        ? ((fullToolResult as { structuredContent?: unknown })
            .structuredContent as Record<string, unknown> | undefined)
        : undefined;
    const tmRaw =
      fullToolResult && typeof fullToolResult === 'object'
        ? (fullToolResult as { _meta?: unknown })._meta
        : undefined;

    // Spec-canonical `_meta.ui.{resourceUri,displayMode}` pickup. Both
    // fields ride on the same `_meta.ui` block per MCP-Apps
    // SEP-1865 / SEP-2133. Legacy `_meta['ui/resourceUri']` flat key is
    // checked as a fallback for older shells.
    let resourceUri: string | undefined;
    if (tmRaw !== null && typeof tmRaw === 'object') {
      const uiBlock = (tmRaw as { ui?: unknown }).ui;
      if (uiBlock !== null && typeof uiBlock === 'object') {
        const rawDisplayMode = (uiBlock as { displayMode?: unknown })
          .displayMode;
        if (
          rawDisplayMode === 'inline' ||
          rawDisplayMode === 'fullscreen' ||
          rawDisplayMode === 'pip'
        ) {
          setHostDisplayMode(rawDisplayMode);
        }
        const rawResourceUri = (uiBlock as { resourceUri?: unknown })
          .resourceUri;
        if (typeof rawResourceUri === 'string' && rawResourceUri.length > 0) {
          resourceUri = rawResourceUri;
        }
      }
      if (resourceUri === undefined) {
        const flatLegacy = (tmRaw as { 'ui/resourceUri'?: unknown })[
          'ui/resourceUri'
        ];
        if (typeof flatLegacy === 'string' && flatLegacy.length > 0) {
          resourceUri = flatLegacy;
        }
      }
    }

    const content = ((msg.message as { content?: unknown[] })?.content ??
      []) as Array<Record<string, unknown>>;
    let i = 0;
    for (const block of content) {
      i += 1;
      if (block.type !== 'tool_result') continue;
      const toolUseId =
        typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const textBlocks = Array.isArray(block.content)
        ? (block.content as Array<Record<string, unknown>>)
            .filter((c) => c?.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string)
        : typeof block.content === 'string'
          ? [block.content as string]
          : [];
      // Patch the tool-call entry with the structured result if
      // available (richer than the stripped text); fall back to joined
      // text otherwise.
      const result: unknown = sc ?? textBlocks.join('\n');
      if (toolUseId.length > 0) {
        patchToolCall(toolUseId, {
          result,
          ...(block.is_error === true ? { isError: true } : {}),
        });
      }
      // Spec-canonical iframe mount: any tool_result whose `_meta.ui.
      // resourceUri` is set becomes a render entry. Dedupes by URI in
      // addRender — `*_update`-style calls that return the same URI
      // coalesce onto the existing iframe.
      if (resourceUri === undefined) continue;
      const item: RenderRef = {
        resourceUri,
        action: 'render',
        ...(toolUseId.length > 0 ? { toolUseId } : {}),
      };
      addRender(item);
      append({
        id: `${baseId}.s${i}`,
        kind: 'render',
        render: item,
      });
    }
    return;
  }
  if (msg.type === 'result') {
    append({
      id: baseId,
      kind: 'end',
      subtype: String(msg.subtype ?? 'ok'),
    });
    return;
  }
}

/**
 * Snapshot returned by `GET <snapshotEndpoint>?chatId=<id>`. `messages`
 * is the verbatim SDK message stream the server observed during the
 * live conversation (replayed through `handleEvent` to rebuild the chat
 * panel). `renders` is an optional list of resource URIs (mounted
 * directly for any iframe whose URI didn't ride inline on a recorded
 * SDKMessage).
 *
 * Servers may omit `renders` entirely when the SDK preserves `_meta` on
 * tool_use_result (the replay path mounts iframes by itself).
 */
interface ChatSnapshotResponse {
  readonly chatId: string;
  readonly messages?: ReadonlyArray<unknown>;
  readonly renders?: ReadonlyArray<RestoredRender>;
}

interface RestoredRender {
  readonly resourceUri: string;
  readonly action?: string;
  readonly toolUseId?: string;
}

/**
 * Stable per-turn id. Uses crypto.randomUUID when available; falls back
 * to a millisecond-timestamp + random suffix in SSR / non-crypto
 * environments (the value is opaque to the user and only needs to be
 * unique within a chat session).
 */
function mintTurnId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `t.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  }
}
