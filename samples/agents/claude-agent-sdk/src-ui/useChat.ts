/* eslint-disable no-console */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseMcpAppAiGguiRenderMeta,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { ChatEntry, RenderRef, ToolCallEntry } from './types';

/**
 * Host-display-mode hint, parsed from the most-recent render's
 * `_meta.ui.displayMode` (spec-native MCP-Apps SEP-1865). Drives the
 * sample's `Inline | Panel` layout when present: `'fullscreen'` /
 * `'pip'` → Panel; `'inline'` → Inline; absent → no auto-switch.
 *
 * Sample-agent's `App.defaultDisplayMode` (set in `ggui.json`) stamps
 * this on every render from the server side; agents can also override
 * per-render via `ggui_render.input.displayMode`.
 */
type HostDisplayMode = 'inline' | 'fullscreen' | 'pip';

interface UseChatResult {
  readonly entries: ReadonlyArray<ChatEntry>;
  readonly renders: ReadonlyArray<RenderRef>;
  /**
   * Most-recent host-side presentation hint stamped on a render, or
   * `undefined` when no render has yet carried one (or the app omitted
   * `defaultDisplayMode`). `Chat.tsx` reads this to auto-switch its
   * `Inline | Panel` layout.
   */
  readonly hostDisplayMode: HostDisplayMode | undefined;
  readonly sending: boolean;
  readonly send: (prompt: string) => Promise<void>;
  /**
   * Abort the in-flight stream. Cancels the `fetch` against `/chat` via
   * its AbortController, which propagates as a network-level abort on
   * the server (the SSE write loop sees the broken pipe and unwinds the
   * Anthropic SDK call). No-op when nothing is in flight.
   */
  readonly abort: () => void;
  /**
   * Mint a fresh chatId and navigate the page to it — drives
   * the "+ New" button in the header. Discards the current chat
   * history's view (the persisted SQLite rows remain on the server,
   * reachable by URL).
   */
  readonly newSession: () => void;
}

/**
 * Drives the SSE conversation with the Node server's /chat endpoint.
 *
 * State shape:
 *   - `entries[]`     — ordered chat log, includes user prompts,
 *                       assistant text, tool-call notation, embedded
 *                       render entries (the actual MCP App
 *                       iframes), errors, and end markers.
 *   - `renders[]`     — flat list of every UI the agent has rendered
 *                       this conversation. Latest at the end. Useful
 *                       for panel mode where we show only the top.
 *   - `sending`       — true while an SSE stream is in progress.
 *
 * **R5 meta-recovery path.** The Anthropic SDK strips `_meta` from
 * `tool_result` blocks (the API spec only allows text content), so we
 * have to recover the `ai.ggui/render` slice envelope another way. R5
 * dropped the `/r/<shortCode>` HTTP fallback (bearer-by-obscurity); the
 * replacement is the wsToken-gated `GET /api/renders/:renderId/state`
 * endpoint. We poll it once after each ggui_render / ggui_update result
 * lands and surface the parsed meta on the matching RenderRef.
 * Render.tsx builds the iframe HTML from the meta on each render.
 */
export function useChat(): UseChatResult {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [renders, setRenders] = useState<RenderRef[]>([]);
  const [hostDisplayMode, setHostDisplayMode] = useState<
    HostDisplayMode | undefined
  >(undefined);
  const [sending, setSending] = useState(false);
  // Mirror of the latest renders for the meta-refetch lookup.
  // Plain state would close over the snapshot at handleEvent-call time;
  // the ref always reads current.
  const rendersRef = useRef<RenderRef[]>([]);
  rendersRef.current = renders;
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

  const addRender = useCallback((item: RenderRef) => {
    setRenders((prev) => {
      // Dedupe by renderId — re-renders / updates land on the same
      // bucket rather than spawning a new iframe each time.
      if (prev.some((p) => p.renderId === item.renderId)) return prev;
      return [...prev, item];
    });
  }, []);


  /**
   * Patch the meta slice on an existing render by id. Used
   * by the meta-refetch effect after every ggui_render and every
   * ggui_update tool_result. Render.tsx rebuilds its inline HTML
   * (and the toolResult forwarded to AppRenderer) whenever this meta
   * field transitions, so the iframe-runtime sees fresh state
   * either as the initial `__GGUI_META__` global (first mount) or as a
   * spec-canonical `ui/notifications/tool-result` frame (subsequent
   * updates).
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
   * Recover the slice envelope via the R6 wsToken-gated state endpoint.
   * The previous `/r/<shortCode>` HTTP path was retired in R5; the
   * `/api/renders/:renderId/state` endpoint is the spec-canonical
   * replacement and the only way to read render state via HTTP after
   * R5.
   *
   * The wsToken lives on the slice envelope itself (`meta.wsToken`)
   * — chicken-and-egg solved by the fact that the FIRST envelope arrives
   * inline on tool_result `_meta` (when the SDK doesn't strip it) or is
   * already cached from a previous tick. The hook holds the
   * most-recently-known meta in `rendersRef`; the polling fetch
   * carries forward the previously-seen wsToken.
   *
   * Returns null when no wsToken is reachable (first tick on a strip-
   * happy SDK like Anthropic; the iframe shows the loading placeholder
   * until the next /state poll succeeds).
   */
  const refetchStateById = useCallback(
    async (renderId: string) => {
      const existing = rendersRef.current.find(
        (p) => p.renderId === renderId,
      );
      const wsToken = existing?.meta?.wsToken;
      if (!renderId) return;
      const search =
        typeof wsToken === 'string' && wsToken.length > 0
          ? `?wsToken=${encodeURIComponent(wsToken)}`
          : '';
      try {
        const res = await fetch(
          `/api/renders/${encodeURIComponent(renderId)}/state${search}`,
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
              '[useChat] /state 401 — no wsToken yet; iframe will retry on the next render/update.',
            );
            return;
          }
          console.warn('[useChat] /state non-2xx', res.status);
          return;
        }
        const envelope = (await res.json()) as unknown;
        const parsedMeta = parseMcpAppAiGguiRenderMeta(envelope);
        if (!parsedMeta.ok || !parsedMeta.meta) return;
        updateRenderMeta(renderId, parsedMeta.meta);
      } catch (err) {
        console.warn('[useChat] /state refetch failed', err);
      }
    },
    [updateRenderMeta],
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
            // Stable per-tab chat id. Persists across page
            // refreshes via sessionStorage (cleared on tab close); a
            // new tab gets a fresh id. The server keys its per-chat
            // agent state on this header so multi-turn flows preserve
            // conversation history, ggui renderId, and render
            // continuity. Missing header = server auto-mints
            // per-request → degrades to single-turn isolation.
            'X-Chat-Id': getOrCreateChatId(),
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
              addRender,
              setHostDisplayMode,
              updateRenderMeta,
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
      addRender,
      updateRenderMeta,
      patchToolCall,
      refetchStateById,
    ],
  );

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // Start a fresh conversation: mint a new chatId, stamp it
  // into the URL, then hard-reload so the React tree and every iframe
  // boot fresh from scratch. Doing this in-place via setState would
  // leak stale render iframes + the restored chat history; a
  // navigation is the cleanest reset. URL is authoritative — no
  // localStorage write needed.
  const newSession = useCallback(() => {
    const fresh = crypto.randomUUID();
    window.location.href = `/?${URL_CHAT_PARAM}=${encodeURIComponent(fresh)}`;
  }, []);

  // On-mount rehydration. When the URL carries a `?chat=<id>` the
  // user is opening a previously-visited conversation; ask the host
  // for the list of ggui renders tied to that chatId and
  // mount each as a fresh RenderRef. No chat-message history is
  // restored here — the iframe IS the conversation in ggui's
  // worldview, and the agent will pick up again on the next `send`
  // whether or not text history is shown.
  useEffect(() => {
    const chatId = getOrCreateChatId();
    if (!chatId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/chat/restore?chatId=${encodeURIComponent(chatId)}`,
          { headers: { Accept: 'application/json' } },
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          readonly renders?: ReadonlyArray<RestoreBootstrap>;
        };
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
          append({
            id: `restored.${renderId}`,
            kind: 'render',
            render: item,
          });
        }
      } catch (err) {
        console.warn('[useChat] /chat/restore failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run exactly once on mount — the chatId is stable for the
    // page lifetime per getOrCreateChatId's contract.
  }, []);

  return { entries, renders, hostDisplayMode, sending, send, abort, newSession };
}

function handleEvent(
  eventType: string,
  payload: unknown,
  baseId: string,
  append: (e: ChatEntry) => void,
  addRender: (s: RenderRef) => void,
  setHostDisplayMode: (mode: HostDisplayMode | undefined) => void,
  updateRenderMeta: (renderId: string, meta: McpAppAiGguiRenderMeta) => void,
  patchToolCall: (
    toolUseId: string,
    patch: { readonly result?: unknown; readonly isError?: boolean },
  ) => void,
  refetchStateById: (renderId: string) => Promise<void>,
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
    // renderId to spawn / update a render entry.
    //
    // KEY INSIGHT: Anthropic Agent SDK preserves the FULL original MCP
    // tool result on `tool_use_result` (sibling of `message`), even
    // though `message.content` is stripped to Anthropic-API-spec-
    // compliant blocks (no structuredContent, no _meta). This is the
    // ONLY place we can read ggui_render's `{renderId, action}`
    // structured fields and — crucially — the inline slice envelope on
    // `_meta["ai.ggui/render"]`. When `_meta` is present we skip the
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
    let initialMeta: McpAppAiGguiRenderMeta | undefined;
    if (tmRaw !== undefined && tmRaw !== null) {
      const parsedMeta = parseMcpAppAiGguiRenderMeta(tmRaw);
      if (parsedMeta.ok && parsedMeta.meta !== undefined) {
        initialMeta = parsedMeta.meta;
      }
    }

    // Host-display-mode hint pickup. `_meta.ui.displayMode` is the
    // spec-native MCP-Apps SEP-1865 per-render presentation hint —
    // stamped from `App.defaultDisplayMode` (or `ggui_render.input
    // .displayMode` override) by the server. Drives the
    // sample's Inline | Panel layout auto-switch in `Chat.tsx`.
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
      // ggui_render's structuredContent carries {renderId, action} plus
      // the ai.ggui/render meta envelope (the full bootstrap slice).
      // ggui_update echoes {renderId, updated:true} — we use the
      // presence of `updated` to discriminate.
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
        // tool_use_result._meta — that's the fast path. Fall back to the
        // wsToken-gated /state endpoint only when _meta is absent (e.g.
        // a fixture-only tool that didn't stamp the ggui slice envelope).
        if (!initialMeta) {
          void refetchStateById(renderId);
        }
        continue;
      }
      // ggui_update branch — patch the live render's meta in place so
      // AppRenderer's `toolResult` useMemo refreshes and postMessages a
      // spec-canonical `ui/notifications/tool-result` to the iframe;
      // iframe-runtime applies the new `propsJson` without a re-mount.
      //
      // Safe paired with Render.tsx's html-pin (htmlRef keyed on
      // renderId): the html string AppRenderer sees stays stable, so
      // the inner iframe is never torn down. Only `toolResult` changes
      // — which is exactly the spec-canonical update channel.
      //
      // WS `props_update` remains the first-party fast path; this is
      // the cross-host fallback for clients where the WS subscription
      // isn't open (self-contained mounts, transient WS gap).
      if (sc.updated === true) {
        // Fast path: slice envelope rode inline on tool_use_result._meta
        // (Anthropic SDK preserves _meta when MCP tools opt-in via
        // _meta.ui — flatten's update.ts emits the full slice envelope
        // here including patched propsJson). No /state poll needed.
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
 * Stable per-conversation chat id. Resolution:
 *
 *   1. URL `?chat=<id>` query param — authoritative. Every link to
 *      "this conversation" carries the id, so opening the URL in any
 *      tab/window restores that specific conversation, the same way
 *      claude.ai's `/c/<id>` URLs work.
 *   2. Mint fresh UUID and stamp it into the URL.
 *
 * Visiting `/` (no query param) ALWAYS starts a fresh conversation —
 * no localStorage-based "resume last chat" fallback. That fallback
 * surprised debugging (every visit auto-loaded the last conversation,
 * hiding fresh-start bugs); the explicit "+ New" button replaces the
 * affordance more visibly, and copy/pasted URLs give intentional
 * resume.
 *
 * SSR-safe: returns a throwaway id when neither URL API nor crypto
 * is available; the resulting chat is single-turn isolated.
 */
const URL_CHAT_PARAM = 'chat';

function getOrCreateChatId(): string {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get(URL_CHAT_PARAM);
    if (fromUrl && fromUrl.length > 0) return fromUrl;
    const resolved = crypto.randomUUID();
    url.searchParams.set(URL_CHAT_PARAM, resolved);
    window.history.replaceState({}, '', url.toString());
    return resolved;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * Restored bootstrap entry returned by GET /chat/restore. The frontend
 * uses this to spawn RenderRefs without going through a tool-result
 * round-trip — the iframe-runtime mounts straight from the bootstrap
 * envelope the server fetched on our behalf.
 */
interface RestoreBootstrap {
  readonly renderId: string;
  readonly bootstrap: Record<string, unknown> | null;
}
