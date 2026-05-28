/* eslint-disable no-console */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseMcpAppAiGguiRenderMeta,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
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
   * frame through the internal SDK-message handler. Sample default:
   * `/chat` on the same origin.
   */
  readonly chatEndpoint: string;
  /**
   * GET endpoint for the server-authoritative chat snapshot. Called
   * once on mount with `?chatId=<id>`. Returns `{messages, renders}` —
   * `messages` are SDK messages (replayed through the same handler the
   * live SSE stream uses), `renders` are bootstrap envelopes for any
   * iframe whose envelope didn't ride inline on a recorded SDKMessage.
   * Defaults to the same URL as {@link chatEndpoint}.
   *
   * Returning 404 = "fresh chatId" → empty conversation. Returning a
   * non-404 error logs a warning and the chat boots blank.
   */
  readonly snapshotEndpoint?: string;
  /**
   * URL prefix for the wsToken-gated render-state polling endpoint.
   * Used to recover the slice envelope when the LLM SDK strips `_meta`
   * from tool_result blocks (Anthropic's Messages API spec is the
   * canonical strip-happy host). The hook appends
   * `/<encodedRenderId>/state?wsToken=<token>`.
   *
   * Default: `/api/renders` (relative to the page origin, proxied by
   * the sample's HTTP server to the ggui MCP server).
   */
  readonly stateEndpointPrefix?: string;
  /**
   * Stable per-conversation chat id. The hook adds this as the
   * `X-Chat-Id` header on every POST. Host apps generate / persist the
   * id however they like (URL query, localStorage, server cookie); the
   * hook never mints one on its own.
   */
  readonly chatId: string;
}

/**
 * Public return of {@link useMcpAppsChat}.
 *
 * `entries[]` is the render-ready chat log; `renders[]` is every ggui
 * render the agent has produced this conversation (latest at the end).
 * Sample chat panels render `entries` inline and pass `renders[i]` to
 * `<AppRenderer>` for iframe mounting.
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
   */
  readonly send: (prompt: string) => Promise<void>;
  /**
   * Abort the in-flight stream. Cancels the `fetch` via its
   * AbortController, which propagates as a network-level abort on the
   * server (SSE write loop sees the broken pipe and unwinds the agent
   * call). No-op when nothing is in flight.
   */
  readonly abort: () => void;
}

/**
 * Canonical hook for chat shells that drive an MCP-Apps-spec agent
 * backend and want to mount ggui renders inline.
 *
 * The hook is responsible for all ggui-shape knowledge:
 *
 *   - Parses `tool_use_result._meta` for the `ai.ggui/render` slice
 *     envelope (via `parseMcpAppAiGguiRenderMeta`).
 *   - Polls the wsToken-gated `/api/renders/:id/state` endpoint as a
 *     fallback when the SDK strips `_meta` (Anthropic).
 *   - Tracks `_meta.ui.displayMode` and exposes the latest as
 *     `hostDisplayMode` for layout auto-switch.
 *   - Discriminates `ggui_render` (new iframe) vs `ggui_update` (patch
 *     existing meta in place so `<AppRenderer toolResult>` re-projects
 *     via `ui/notifications/tool-result`).
 *
 * Host apps remain MCP-spec-only: they receive a stream of SDK messages
 * from their agent endpoint, hand them to this hook, and render
 * `entries[]` + `renders[]`. No `_meta` parsing in the agent backend; no
 * ggui-shape constants in the chat panel. Sample-agents stay
 * brand-agnostic — they only inject the ggui system prompt and host the
 * ggui MCP server, and could swap to any other MCP-Apps-spec UI without
 * touching this hook.
 */
export function useMcpAppsChat(
  opts: UseMcpAppsChatOptions,
): UseMcpAppsChatResult {
  const {
    chatEndpoint,
    chatId,
    snapshotEndpoint = chatEndpoint,
    stateEndpointPrefix = '/api/renders',
  } = opts;

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [renders, setRenders] = useState<RenderRef[]>([]);
  const [hostDisplayMode, setHostDisplayMode] = useState<
    HostDisplayMode | undefined
  >(undefined);
  const [sending, setSending] = useState(false);
  // Mirror of the latest renders for the meta-refetch lookup. Plain
  // state would close over the snapshot at handler-call time; the ref
  // always reads current.
  const rendersRef = useRef<RenderRef[]>([]);
  rendersRef.current = renders;
  // AbortController for the in-flight chat stream. Replaced on every
  // `send`; consumed by `abort`. Ref (not state) because abort is fire-
  // and-forget — no re-render needed when it changes.
  const abortControllerRef = useRef<AbortController | null>(null);

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
      // Dedupe by renderId — re-renders / updates land on the same
      // bucket rather than spawning a new iframe each time.
      if (prev.some((p) => p.renderId === item.renderId)) return prev;
      return [...prev, item];
    });
  }, []);

  /**
   * Patch the meta slice on an existing render by id. Used by the
   * meta-refetch effect after every ggui_render and every ggui_update
   * tool_result. `<AppRenderer toolResult>` re-projects via
   * `ui/notifications/tool-result` whenever this meta field
   * transitions, so iframe-runtime applies the new `propsJson` without
   * tearing down the inner React tree.
   */
  const updateRenderMeta = useCallback(
    (renderId: string, meta: McpAppAiGguiRenderMeta) => {
      setRenders((prev) => {
        const idx = prev.findIndex((p) => p.renderId === renderId);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx]!, meta };
        return next;
      });
    },
    [],
  );

  /**
   * Recover the slice envelope via the wsToken-gated state endpoint.
   * The wsToken lives on the slice envelope itself (`meta.wsToken`) —
   * chicken-and-egg solved by the fact that the FIRST envelope arrives
   * inline on tool_result `_meta` (when the SDK doesn't strip it) or
   * is already cached from a previous tick. The hook holds the
   * most-recently-known meta in `rendersRef`; the polling fetch
   * carries forward the previously-seen wsToken.
   *
   * Returns silently when no wsToken is reachable (first tick on a
   * strip-happy SDK like Anthropic; the iframe shows the loading
   * placeholder until the next /state poll succeeds).
   */
  const refetchStateById = useCallback(
    async (renderId: string) => {
      if (!renderId) return;
      const existing = rendersRef.current.find(
        (p) => p.renderId === renderId,
      );
      const wsToken = existing?.meta?.wsToken;
      const search =
        typeof wsToken === 'string' && wsToken.length > 0
          ? `?wsToken=${encodeURIComponent(wsToken)}`
          : '';
      try {
        const res = await fetch(
          `${stateEndpointPrefix}/${encodeURIComponent(renderId)}/state${search}`,
          { headers: { Accept: 'application/json' } },
        );
        if (!res.ok) {
          if (res.status === 401) {
            // No wsToken or invalid — expected on the very first call
            // when the SDK stripped _meta. The endpoint is wsToken-
            // gated by design; without an inline _meta delivery we have
            // no credential to present. Iframe stays in the loading
            // state until the next render/update lands inline.
            console.warn(
              '[useMcpAppsChat] /state 401 — no wsToken yet; iframe will retry on the next render/update.',
            );
            return;
          }
          console.warn('[useMcpAppsChat] /state non-2xx', res.status);
          return;
        }
        const envelope = (await res.json()) as unknown;
        const parsedMeta = parseMcpAppAiGguiRenderMeta(envelope);
        if (!parsedMeta.ok || !parsedMeta.meta) return;
        updateRenderMeta(renderId, parsedMeta.meta);
      } catch (err) {
        console.warn('[useMcpAppsChat] /state refetch failed', err);
      }
    },
    [stateEndpointPrefix, updateRenderMeta],
  );

  const send = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const turnId = mintTurnId();
      append({ id: `${turnId}.user`, kind: 'user', text: trimmed });
      setSending(true);
      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        const res = await fetch(chatEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Chat-Id': chatId,
          },
          body: JSON.stringify({ prompt: trimmed }),
          signal: controller.signal,
        });
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
            counter += 1;
            handleEvent(eventType, payload, `${turnId}.${counter}`, {
              append,
              addRender,
              setHostDisplayMode,
              updateRenderMeta,
              patchToolCall,
              refetchStateById,
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
    [
      append,
      addRender,
      chatEndpoint,
      chatId,
      patchToolCall,
      refetchStateById,
      updateRenderMeta,
    ],
  );

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // On-mount rehydration. When the host provides a chatId for a
  // previously-visited conversation, pull the server-authoritative
  // snapshot and re-feed it through the same `handleEvent` pipeline the
  // live SSE stream uses. The server holds the SDK message stream
  // verbatim plus bootstrap envelopes captured on every tool_result, so
  // replaying them rebuilds the chat panel AND mounts iframes without
  // re-prompting the agent. The `renders` field is a hedge: handleEvent
  // mounts iframes from each user-frame's `tool_use_result._meta`, but
  // we also apply the explicit renders[] map to cover any envelope
  // whose SDKMessage carrier dropped `_meta` in transit.
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${snapshotEndpoint}?chatId=${encodeURIComponent(chatId)}`,
          { headers: { Accept: 'application/json' } },
        );
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
            updateRenderMeta,
            patchToolCall,
            refetchStateById,
          });
        }
        // Mount any renders whose envelope didn't ride inline on a
        // recorded SDKMessage (defensive — server-side capture already
        // picks these up). Dedupes by renderId via addRender, so
        // iframes already mounted from the replay above get their meta
        // refreshed in place rather than duplicated.
        for (const entry of body.renders ?? []) {
          if (cancelled) return;
          if (!entry.bootstrap) continue;
          const parsed = parseMcpAppAiGguiRenderMeta(entry.bootstrap);
          if (!parsed.ok || !parsed.meta) continue;
          const renderId = parsed.meta.renderId;
          if (!renderId) continue;
          const item: RenderRef = {
            renderId,
            action: 'restored',
            meta: parsed.meta,
          };
          addRender(item);
          updateRenderMeta(renderId, parsed.meta);
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
  }, [chatId, snapshotEndpoint, append, addRender, patchToolCall, refetchStateById, updateRenderMeta]);

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
  readonly updateRenderMeta: (
    renderId: string,
    meta: McpAppAiGguiRenderMeta,
  ) => void;
  readonly patchToolCall: (
    toolUseId: string,
    patch: { readonly result?: unknown; readonly isError?: boolean },
  ) => void;
  readonly refetchStateById: (renderId: string) => Promise<void>;
}

function handleEvent(
  eventType: string,
  payload: unknown,
  baseId: string,
  deps: HandleEventDeps,
): void {
  const {
    append,
    addRender,
    setHostDisplayMode,
    updateRenderMeta,
    patchToolCall,
    refetchStateById,
  } = deps;
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
    // the ggui slice envelope when present and either spawn a new
    // render entry or patch an existing one in place.
    //
    // KEY INSIGHT: Anthropic Agent SDK (and equivalents) preserve the
    // FULL original MCP tool result on `tool_use_result` (sibling of
    // `message`), even though `message.content` is stripped to
    // Anthropic-API-spec-compliant blocks (no structuredContent, no
    // _meta). This is the ONLY place we can read ggui_render's
    // `{renderId, action}` structured fields and the inline slice
    // envelope on `_meta["ai.ggui/render"]`. When `_meta` is present
    // we skip the wsToken-gated /state poll entirely, sidestepping the
    // chicken-and-egg first-mount race.
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
    let initialMeta: McpAppAiGguiRenderMeta | undefined;
    if (tmRaw !== undefined && tmRaw !== null) {
      const parsedMeta = parseMcpAppAiGguiRenderMeta(tmRaw);
      if (parsedMeta.ok && parsedMeta.meta !== undefined) {
        initialMeta = parsedMeta.meta;
      }
    }

    // Host-display-mode hint pickup. `_meta.ui.displayMode` is the
    // spec-native MCP-Apps SEP-1865 per-render presentation hint —
    // stamped from `App.defaultDisplayMode` (or
    // `ggui_render.input.displayMode` override) by the server.
    if (tmRaw !== null && typeof tmRaw === 'object') {
      const uiBlock = (tmRaw as { ui?: unknown }).ui;
      if (uiBlock !== null && typeof uiBlock === 'object') {
        const raw = (uiBlock as { displayMode?: unknown }).displayMode;
        if (raw === 'inline' || raw === 'fullscreen' || raw === 'pip') {
          setHostDisplayMode(raw);
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
      // ggui-specific routing: read from structuredContent (preserved
      // on tool_use_result), NOT from text blocks (Anthropic SDK strips
      // structuredContent + _meta from the model-visible content array).
      if (!sc) continue;
      // ggui_render's structuredContent carries {renderId, action} plus
      // the ai.ggui/render meta envelope. ggui_update echoes
      // {renderId, updated:true} — we use the presence of `updated` to
      // discriminate.
      const renderId =
        typeof sc.renderId === 'string' ? sc.renderId : undefined;
      if (!renderId) continue;
      // ggui_render branch — new render entering the chat log.
      if (sc.updated !== true) {
        const item: RenderRef = {
          renderId,
          action: String(sc.action ?? 'create'),
          ...(typeof sc.contractHash === 'string'
            ? { contractHash: sc.contractHash }
            : {}),
          ...(initialMeta ? { meta: initialMeta } : {}),
        };
        addRender(item);
        append({
          id: `${baseId}.s${i}`,
          kind: 'render',
          render: item,
        });
        // No /state poll needed when the slice envelope rode inline on
        // tool_use_result._meta — that's the fast path. Fall back to
        // the wsToken-gated /state endpoint only when _meta is absent.
        if (!initialMeta) {
          void refetchStateById(renderId);
        }
        continue;
      }
      // ggui_update branch — patch the live render's meta in place so
      // `<AppRenderer toolResult>` re-projects via
      // `ui/notifications/tool-result`; iframe-runtime applies the new
      // `propsJson` without a re-mount.
      //
      // Safe paired with a stable html string at the host level:
      // AppRenderer's html stays stable, so the inner iframe is never
      // torn down. Only `toolResult` changes — which is exactly the
      // spec-canonical update channel.
      if (sc.updated === true) {
        // Fast path: slice envelope rode inline on
        // tool_use_result._meta. No /state poll needed.
        if (initialMeta) {
          updateRenderMeta(renderId, initialMeta);
          continue;
        }
        // Fallback: SDK stripped _meta — recover via the wsToken-gated
        // /state endpoint (same pattern used on initial render).
        void refetchStateById(renderId);
        continue;
      }
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
 * panel). `renders` is an optional per-renderId bootstrap map (mounted
 * directly for any iframe whose envelope didn't ride inline on a
 * recorded SDKMessage).
 *
 * Sample servers may omit `renders` entirely when the SDK preserves
 * `_meta` on tool_use_result (the replay path mounts iframes by itself).
 * The Anthropic SDK strips _meta from `message.content` but preserves
 * it on the sibling `tool_use_result.meta`, so even Anthropic-driven
 * samples can leave `renders` empty.
 */
interface ChatSnapshotResponse {
  readonly chatId: string;
  readonly messages?: ReadonlyArray<unknown>;
  readonly renders?: ReadonlyArray<RestoredRender>;
}

interface RestoredRender {
  readonly renderId: string;
  readonly bootstrap: Record<string, unknown> | null;
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
