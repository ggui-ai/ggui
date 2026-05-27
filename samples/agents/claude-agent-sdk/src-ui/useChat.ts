/* eslint-disable no-console */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseMcpAppAiGguiMeta,
  type McpAppAiGguiMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { CanvasRef, ChatEntry, StackItemRef, ToolCallEntry } from './types';

interface UseChatResult {
  readonly entries: ReadonlyArray<ChatEntry>;
  readonly stackItems: ReadonlyArray<StackItemRef>;
  /**
   * Session-scoped canvas iframes for FULLSCREEN-mode sessions. One
   * entry per `ggui_new_session` that stamped a session-scoped
   * `_meta.ui.resourceUri`. Presence in this list = "this session is
   * fullscreen" (the resourceUri-by-tool axiom — see
   * `docs/principles/resource-uri-by-tool.md`).
   */
  readonly canvases: ReadonlyArray<CanvasRef>;
  readonly sending: boolean;
  readonly send: (prompt: string) => Promise<void>;
  /**
   * Abort the in-flight stream. Cancels the `fetch` against `/chat` via
   * its AbortController, which propagates as a network-level abort on
   * the server (the SSE write loop sees the broken pipe and unwinds the
   * Anthropic SDK call). No-op when nothing is in flight.
   */
  readonly abort: () => void;
}

/**
 * Drives the SSE conversation with the Node server's /chat endpoint.
 *
 * State shape:
 *   - `entries[]`     — ordered chat log, includes user prompts,
 *                       assistant text, tool-call notation, embedded
 *                       stack-item entries (the actual MCP App
 *                       iframes), errors, and end markers.
 *   - `stackItems[]`  — flat list of every UI the agent has rendered
 *                       this session. Latest at the end. Useful for
 *                       panel mode where we show only the top.
 *   - `sending`       — true while an SSE stream is in progress.
 *
 * **R5 meta-recovery path.** The Anthropic SDK strips `_meta` from
 * `tool_result` blocks (the API spec only allows text content), so we
 * have to recover the `ai.ggui/*` slice envelope another way. R5
 * dropped the `/r/<shortCode>` HTTP fallback (bearer-by-obscurity); the
 * replacement is the wsToken-gated `GET /api/sessions/:sessionId/state`
 * endpoint. We poll it once after each ggui_push / ggui_update result
 * lands and surface the parsed meta on the matching StackItemRef.
 * StackItem.tsx builds the iframe HTML from the meta on each render.
 */
export function useChat(): UseChatResult {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [stackItems, setStackItems] = useState<StackItemRef[]>([]);
  const [canvases, setCanvases] = useState<CanvasRef[]>([]);
  const [sending, setSending] = useState(false);
  // Mirror of the latest stackItems for the meta-refetch lookup.
  // Plain state would close over the snapshot at handleEvent-call time;
  // the ref always reads current.
  const stackItemsRef = useRef<StackItemRef[]>([]);
  stackItemsRef.current = stackItems;
  // Mirror of fullscreen-mode session ids. The push handler needs a
  // synchronous "is this session fullscreen?" check so it can skip
  // per-push iframe-mounting and emit a compact marker instead. Plain
  // state would close over a stale snapshot inside handleEvent.
  const fullscreenSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    fullscreenSessionsRef.current = new Set(canvases.map((c) => c.sessionId));
  }, [canvases]);
  // AbortController for the in-flight /chat stream. Replaced on every
  // `send`; consumed by `abort` to cancel. Ref (not state) because abort
  // is fire-and-forget — no re-render needed when it changes.
  const abortControllerRef = useRef<AbortController | null>(null);

  const append = useCallback((entry: ChatEntry) => {
    setEntries((prev) => [...prev, entry]);
  }, []);

  /**
   * Patch a tool-call entry by id (Anthropic's `tool_use_id`). Used when
   * the matching `tool_result` block lands on a later SSE frame — we
   * locate the existing entry and merge the result/isError fields.
   * No-ops if the entry doesn't exist (the call was orphaned by an
   * out-of-order delivery; rare but the merge is idempotent).
   */
  const patchToolCall = useCallback(
    (toolUseId: string, patch: { readonly result?: unknown; readonly isError?: boolean }) => {
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

  const addStackItem = useCallback((item: StackItemRef) => {
    setStackItems((prev) => {
      // Dedupe by stackItemId — re-renders / updates land on the same
      // bucket rather than spawning a new iframe each time.
      if (prev.some((p) => p.stackItemId === item.stackItemId)) return prev;
      return [...prev, item];
    });
  }, []);

  const addCanvas = useCallback((canvas: CanvasRef) => {
    setCanvases((prev) => {
      // Dedupe by sessionId — a session has exactly one canvas (the
      // resourceUri-by-tool axiom enforces single new_session per
      // session, so re-firing is a server bug not a race we handle).
      if (prev.some((p) => p.sessionId === canvas.sessionId)) return prev;
      return [...prev, canvas];
    });
  }, []);

  /**
   * Patch the meta slice pair on an existing stack item by id. Used
   * by the meta-refetch effect after every ggui_push and every
   * ggui_update tool_result. StackItem.tsx rebuilds its inline HTML
   * (and the toolResult forwarded to AppRenderer) whenever this meta
   * field transitions, so the iframe-runtime sees fresh state
   * either as the initial `__GGUI_META__` global (first mount) or as a
   * spec-canonical `ui/notifications/tool-result` frame (subsequent
   * updates).
   */
  const updateStackItemMeta = useCallback(
    (stackItemId: string, meta: McpAppAiGguiMeta) => {
      setStackItems((prev) => {
        const idx = prev.findIndex((p) => p.stackItemId === stackItemId);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx]!, meta };
        return next;
      });
    },
    [],
  );

  /**
   * Recover the slice envelope via the R6 wsToken-gated state endpoint.
   * The previous `/r/<shortCode>` HTTP path was retired in R5; the
   * `/api/sessions/:sessionId/state` endpoint is the spec-canonical
   * replacement and the only way to read session state via HTTP after
   * R5.
   *
   * The wsToken lives on the slice envelope itself (`session.wsToken`)
   * — chicken-and-egg solved by the fact that the FIRST envelope arrives
   * inline on tool_result `_meta` (when the SDK doesn't strip it) or is
   * already cached from a previous tick. The hook holds the
   * most-recently-known meta in `stackItemsRef`; the polling fetch
   * carries forward the previously-seen wsToken.
   *
   * Returns null when no wsToken is reachable (first tick on a strip-
   * happy SDK like Anthropic; the iframe shows the loading placeholder
   * until the next /state poll succeeds).
   */
  const refetchStateById = useCallback(
    async (stackItemId: string, sessionId: string) => {
      const existing = stackItemsRef.current.find(
        (p) => p.stackItemId === stackItemId,
      );
      const wsToken = existing?.meta?.session?.wsToken;
      if (!sessionId) return;
      const search =
        typeof wsToken === 'string' && wsToken.length > 0
          ? `?wsToken=${encodeURIComponent(wsToken)}`
          : '';
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/state${search}`,
          { headers: { Accept: 'application/json' } },
        );
        if (!res.ok) {
          if (res.status === 401) {
            // No wsToken or invalid — we expect this on the very first
            // call when the SDK stripped _meta. The /state endpoint is
            // wsToken-gated by design; without an inline _meta delivery
            // we have no credential to present. Iframe stays in the
            // loading state.
            console.warn(
              '[useChat] /state 401 — no wsToken yet; iframe will retry on the next push/update.',
            );
            return;
          }
          console.warn('[useChat] /state non-2xx', res.status);
          return;
        }
        const envelope = (await res.json()) as unknown;
        const parsedMeta = parseMcpAppAiGguiMeta(envelope);
        if (!parsedMeta.ok) return;
        updateStackItemMeta(stackItemId, parsedMeta.meta);
      } catch (err) {
        console.warn('[useChat] /state refetch failed', err);
      }
    },
    [updateStackItemMeta],
  );

  /**
   * Fetch the session-scoped canvas HTML via spec-canonical MCP
   * `resources/read`, proxied through the sample-agent backend's
   * `/relay/resources-read` endpoint. The response's `text` is the
   * full iframe HTML (`__GGUI_META__` already inlined by the server's
   * `buildSelfContainedShell`); `_meta.ui.csp` carries the sandbox-proxy
   * CSP block. Both are required to mount the AppRenderer canvas.
   *
   * Returns `null` on transport / server error — the caller emits a
   * placeholder chat entry so the user sees that something happened on
   * `ggui_new_session` even when the canvas mount degraded.
   */
  const fetchCanvasResource = useCallback(
    async (
      uri: string,
      sessionId: string,
    ): Promise<CanvasRef | null> => {
      try {
        const res = await fetch('/relay/resources-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uri }),
        });
        if (!res.ok) {
          console.warn('[useChat] /relay/resources-read non-2xx', res.status);
          return null;
        }
        const jsonRpc = (await res.json()) as {
          readonly result?: {
            readonly contents?: ReadonlyArray<{
              readonly text?: unknown;
              readonly _meta?: unknown;
            }>;
          };
          readonly error?: { readonly message?: string };
        };
        if (jsonRpc.error !== undefined) {
          console.warn('[useChat] /relay/resources-read error', jsonRpc.error);
          return null;
        }
        const first = jsonRpc.result?.contents?.[0];
        const html =
          first && typeof first.text === 'string' ? first.text : null;
        if (html === null || html.length === 0) {
          console.warn('[useChat] /relay/resources-read empty html');
          return null;
        }
        const cspRaw =
          first && first._meta && typeof first._meta === 'object'
            ? ((first._meta as { ui?: { csp?: unknown } }).ui?.csp as
                | { resourceDomains?: unknown; connectDomains?: unknown }
                | undefined)
            : undefined;
        const csp: CanvasRef['csp'] | undefined =
          cspRaw !== undefined
            ? {
                ...(Array.isArray(cspRaw.resourceDomains)
                  ? {
                      resourceDomains: (
                        cspRaw.resourceDomains as unknown[]
                      ).filter((s): s is string => typeof s === 'string'),
                    }
                  : {}),
                ...(Array.isArray(cspRaw.connectDomains)
                  ? {
                      connectDomains: (
                        cspRaw.connectDomains as unknown[]
                      ).filter((s): s is string => typeof s === 'string'),
                    }
                  : {}),
              }
            : undefined;
        return {
          sessionId,
          resourceUri: uri,
          html,
          ...(csp !== undefined ? { csp } : {}),
        };
      } catch (err) {
        console.warn('[useChat] /relay/resources-read transport error', err);
        return null;
      }
    },
    [],
  );

  const send = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const turnId = crypto.randomUUID();
      append({ id: `${turnId}.user`, kind: 'user', text: trimmed });
      setSending(true);
      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        const res = await fetch('/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Stable per-tab chat-session id. Persists across page
            // refreshes via sessionStorage (cleared on tab close); a
            // new tab gets a fresh id. The server keys its per-chat
            // agent state on this header so multi-turn flows preserve
            // conversation history, ggui sessionId, and stackItem
            // continuity. Missing header = server auto-mints
            // per-request → degrades to single-turn isolation.
            'X-Chat-Session-Id': getOrCreateChatSessionId(),
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
            handleEvent(
              eventType,
              payload,
              `${turnId}.${counter}`,
              append,
              addStackItem,
              addCanvas,
              fullscreenSessionsRef.current,
              fetchCanvasResource,
              updateStackItemMeta,
              patchToolCall,
              refetchStateById,
            );
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
      addStackItem,
      addCanvas,
      fetchCanvasResource,
      updateStackItemMeta,
      patchToolCall,
      refetchStateById,
    ],
  );

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // On-mount rehydration. When the URL carries a `?session=<id>` the
  // user is opening a previously-visited conversation; ask the host
  // for the list of ggui sessions tied to that chatSessionId and
  // mount the latest stack item per session as a fresh StackItemRef.
  // No chat-message history is restored here — the iframe IS the
  // conversation in ggui's worldview, and the agent will pick up
  // again on the next `send` whether or not text history is shown.
  useEffect(() => {
    const chatSessionId = getOrCreateChatSessionId();
    if (!chatSessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/chat/restore?chatSessionId=${encodeURIComponent(chatSessionId)}`,
          { headers: { Accept: 'application/json' } },
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          readonly sessions?: ReadonlyArray<RestoreBootstrap>;
        };
        for (const entry of body.sessions ?? []) {
          if (cancelled) return;
          if (!entry.bootstrap) continue;
          const parsed = parseMcpAppAiGguiMeta(entry.bootstrap);
          if (!parsed.ok) continue;
          const stackItemId = parsed.meta.stackItem?.stackItemId;
          if (!stackItemId) continue;
          const item: StackItemRef = {
            stackItemId,
            sessionId: entry.sessionId,
            action: 'restored',
            meta: parsed.meta,
          };
          addStackItem(item);
          append({
            id: `restored.${stackItemId}`,
            kind: 'stack-item',
            stackItem: item,
          });
        }
      } catch (err) {
        console.warn('[useChat] /chat/restore failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run exactly once on mount — the chatSessionId is stable for the
    // page lifetime per getOrCreateChatSessionId's contract.
  }, []);

  return { entries, stackItems, canvases, sending, send, abort };
}

/**
 * Match the session-scoped resourceUri shape stamped by
 * `ggui_new_session.resultMeta` in fullscreen mode. Returns the
 * session id when the URI shape says "this is a fullscreen-mode canvas
 * resource", null otherwise. Per the resourceUri-by-tool axiom:
 *   - `ui://ggui/session/<sessionId>` (no trailing segment) =
 *     session-scoped canvas (fullscreen)
 *   - `ui://ggui/session/<sessionId>/<shortCode>` (push-scoped) = inline
 *
 * Matching by shape (rather than reading `tool_use_result.name`) keeps
 * the detection independent of the tool's wire name and naturally
 * extends to any future tool that stamps a session-scoped resourceUri.
 */
function parseCanvasResourceUri(uri: string): string | null {
  const match = /^ui:\/\/ggui\/session\/([^/]+)$/.exec(uri);
  return match ? (match[1] ?? null) : null;
}

function handleEvent(
  eventType: string,
  payload: unknown,
  baseId: string,
  append: (e: ChatEntry) => void,
  addStackItem: (s: StackItemRef) => void,
  addCanvas: (c: CanvasRef) => void,
  fullscreenSessions: ReadonlySet<string>,
  fetchCanvasResource: (uri: string, sessionId: string) => Promise<CanvasRef | null>,
  updateStackItemMeta: (stackItemId: string, meta: McpAppAiGguiMeta) => void,
  patchToolCall: (
    toolUseId: string,
    patch: { readonly result?: unknown; readonly isError?: boolean },
  ) => void,
  refetchStateById: (stackItemId: string, sessionId: string) => Promise<void>,
): void {
  if (eventType === 'error') {
    const err = (payload as { error?: string }).error ?? 'Unknown error';
    append({ id: baseId, kind: 'error', text: err });
    return;
  }
  const msg = payload as { type?: string; subtype?: string; message?: unknown };
  if (msg.type === 'assistant') {
    const content = ((msg.message as { content?: unknown[] })?.content ?? []) as Array<
      Record<string, unknown>
    >;
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
    // tool_result replay — Anthropic forwards every tool's result as a
    // user-role message after the SDK invokes the tool. We (a) attach
    // the result to the matching tool-call entry via toolUseId so the
    // expand UI shows full call+result side-by-side, and (b) extract
    // sessionId+stackItemId to spawn / update a stack-item entry.
    //
    // KEY INSIGHT: Anthropic Agent SDK preserves the FULL original MCP
    // tool result on `tool_use_result` (sibling of `message`), even
    // though `message.content` is stripped to Anthropic-API-spec-
    // compliant blocks (no structuredContent, no _meta). This is the
    // ONLY place we can read ggui_push's `{sessionId, stackItemId, ...}`
    // structured fields and — crucially — the inline slice envelope on
    // `_meta["ai.ggui/*"]`. When `_meta` is present we skip the
    // wsToken-gated /state poll entirely, sidestepping the chicken-and-
    // egg first-mount race.
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
    let initialMeta: McpAppAiGguiMeta | undefined;
    if (tmRaw !== undefined && tmRaw !== null) {
      const parsedMeta = parseMcpAppAiGguiMeta(tmRaw);
      if (
        parsedMeta.ok &&
        (parsedMeta.meta.session !== undefined ||
          parsedMeta.meta.stackItem !== undefined)
      ) {
        initialMeta = parsedMeta.meta;
      }
    }

    // Fullscreen-mode canvas detection (resourceUri-by-tool axiom —
    // see `docs/principles/resource-uri-by-tool.md`). When a tool
    // result carries `_meta.ui.resourceUri = ui://ggui/session/<id>`
    // (no shortcode suffix), the session is in fullscreen mode and the
    // host MUST mount ONE session-scoped canvas iframe — independent of
    // which tool stamped it (currently only `ggui_new_session` does, but
    // the matcher works on shape so any future session-scoped stamper
    // lands on the same path). Subsequent pushes for this sessionId
    // become compact markers (the canvas owns rendering via WS).
    const uiResourceUri =
      tmRaw && typeof tmRaw === 'object'
        ? ((tmRaw as { ui?: { resourceUri?: unknown } }).ui?.resourceUri as
            | string
            | undefined)
        : undefined;
    if (typeof uiResourceUri === 'string' && uiResourceUri.length > 0) {
      const canvasSessionId = parseCanvasResourceUri(uiResourceUri);
      if (canvasSessionId !== null) {
        void (async () => {
          const canvas = await fetchCanvasResource(
            uiResourceUri,
            canvasSessionId,
          );
          if (canvas !== null) {
            addCanvas(canvas);
            append({
              id: `${baseId}.canvas`,
              kind: 'canvas',
              canvas,
            });
          }
        })();
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
      // Patch the tool-call entry with the structured result if available
      // (richer than the stripped text); fall back to joined text otherwise.
      const result: unknown = sc ?? textBlocks.join('\n');
      if (toolUseId.length > 0) {
        patchToolCall(toolUseId, {
          result,
          ...(block.is_error === true ? { isError: true } : {}),
        });
      }
      // ggui-specific routing: read from structuredContent (preserved on
      // tool_use_result), NOT from text blocks (Anthropic SDK strips
      // structuredContent + _meta from the model-visible content array).
      if (!sc) continue;
      // ggui_push's structuredContent intentionally OMITS sessionId
      // (see pushOutputSchema docstring: "the iframe receives bootstrap
      // credentials via the ai.ggui/session slice meta, not via this
      // response"). We read sessionId from initialMeta.session.sessionId
      // (extracted from tool_use_result._meta) and stackItemId from sc.
      const sessionId = initialMeta?.session?.sessionId;
      const stackItemId =
        typeof sc.stackItemId === 'string' ? sc.stackItemId : undefined;
      if (!sessionId || !stackItemId) continue;
      // ggui_push branch — new stack item entering the chat log.
      if (sc.updated !== true) {
        // Fullscreen-mode short-circuit: the session canvas already
        // owns rendering. The server-side `canvasOwnsRender` gate
        // (see `push.ts.resultMeta`) omits per-call resourceUri AND
        // fans the stack item through the WS subscribe ack. The host's
        // only job here is a chat-log marker so the conversation
        // doesn't go silent on a push that lands inside the canvas.
        if (fullscreenSessions.has(sessionId)) {
          append({
            id: `${baseId}.s${i}`,
            kind: 'push-marker',
            sessionId,
            stackItemId,
            action: String(sc.action ?? 'create'),
          });
          continue;
        }
        const item: StackItemRef = {
          stackItemId,
          sessionId,
          action: String(sc.action ?? 'create'),
          ...(typeof sc.contractHash === 'string'
            ? { contractHash: sc.contractHash }
            : {}),
          ...(initialMeta ? { meta: initialMeta } : {}),
        };
        addStackItem(item);
        append({
          id: `${baseId}.s${i}`,
          kind: 'stack-item',
          stackItem: item,
        });
        // No /state poll needed when the slice envelope rode inline on
        // tool_use_result._meta — that's the fast path. Fall back to the
        // wsToken-gated /state endpoint only when _meta is absent (e.g.
        // a fixture-only tool that didn't stamp the ggui slice envelope).
        if (!initialMeta) {
          void refetchStateById(stackItemId, sessionId);
        }
        continue;
      }
      // ggui_update branch — existing stack item gets new props.
      if (sc.updated === true) {
        if (initialMeta) {
          updateStackItemMeta(stackItemId, initialMeta);
        } else {
          void refetchStateById(stackItemId, sessionId);
        }
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
 * Stable per-conversation chat-session id, resolved in this order:
 *
 *   1. URL `?session=<id>` query param. Source of truth — every link
 *      to "this conversation" carries the id, so opening the URL in
 *      a new tab / window restores the same conversation, the same
 *      way claude.ai's `/c/<id>` URLs work.
 *   2. `localStorage` last-viewed id (CHAT_SESSION_STORAGE_KEY). Falls
 *      back here when the root URL is visited with no `?session=`;
 *      we redirect the URL to `?session=<last>` so step (1) holds
 *      for every subsequent action.
 *   3. Mint fresh UUID + write to URL + localStorage.
 *
 * Migrated from `sessionStorage` to `localStorage` so a closed-and-
 * reopened tab still resumes the user's most-recent conversation
 * (sessionStorage clears on tab close).
 *
 * SSR-safe: returns a throwaway id when neither storage nor URL API
 * is available; the resulting chat is single-turn isolated.
 */
const CHAT_SESSION_STORAGE_KEY = 'ggui-chat-session-id';
const URL_SESSION_PARAM = 'session';

function getOrCreateChatSessionId(): string {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get(URL_SESSION_PARAM);
    if (fromUrl && fromUrl.length > 0) {
      // URL is authoritative — keep localStorage in sync as
      // "most-recently-viewed" so a future visit to `/` resumes here.
      try {
        window.localStorage.setItem(CHAT_SESSION_STORAGE_KEY, fromUrl);
      } catch {
        // localStorage blocked — URL-only mode still works.
      }
      return fromUrl;
    }
    let lastViewed: string | null = null;
    try {
      lastViewed = window.localStorage.getItem(CHAT_SESSION_STORAGE_KEY);
    } catch {
      // localStorage blocked — fall through to fresh mint.
    }
    const resolved =
      lastViewed && lastViewed.length > 0 ? lastViewed : crypto.randomUUID();
    url.searchParams.set(URL_SESSION_PARAM, resolved);
    window.history.replaceState({}, '', url.toString());
    try {
      window.localStorage.setItem(CHAT_SESSION_STORAGE_KEY, resolved);
    } catch {
      // ignore
    }
    return resolved;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * Restored bootstrap entry returned by GET /chat/restore. The frontend
 * uses this to spawn StackItemRefs without going through a tool-result
 * round-trip — the iframe-runtime mounts straight from the bootstrap
 * envelope the server fetched on our behalf.
 */
interface RestoreBootstrap {
  readonly sessionId: string;
  readonly bootstrap: Record<string, unknown> | null;
}
