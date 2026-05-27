/* eslint-disable no-console */
import { useCallback, useRef, useState } from 'react';
import {
  parseMcpAppAiGguiRenderMeta,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { ChatEntry, RenderRef, ToolCallEntry } from './types';

interface UseChatResult {
  readonly entries: ReadonlyArray<ChatEntry>;
  readonly renders: ReadonlyArray<RenderRef>;
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
            // Stable per-tab chat-session id. Persists across page
            // refreshes via sessionStorage (cleared on tab close); a
            // new tab gets a fresh id. The server keys its per-chat
            // agent state on this header so multi-turn flows preserve
            // conversation history, ggui renderId, and render
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
              addRender,
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
      patchToolCall,
      refetchStateById,
    ],
  );

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  return { entries, renders, sending, send, abort };
}

function handleEvent(
  eventType: string,
  payload: unknown,
  baseId: string,
  append: (e: ChatEntry) => void,
  addRender: (s: RenderRef) => void,
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
    // tool_result replay — the SDK forwards every tool's result as a
    // user-role message after the SDK invokes the tool. We (a) attach
    // the result to the matching tool-call entry via toolUseId so the
    // expand UI shows full call+result side-by-side, and (b) sniff for
    // a renderId to spawn / update a render entry.
    const content = ((msg.message as { content?: unknown[] })?.content ?? []) as Array<
      Record<string, unknown>
    >;
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
      // Build a structured result payload: prefer parsed JSON if every
      // text block parses, otherwise keep the joined raw text. The
      // expand UI prints whatever we hand it.
      const parsedTexts: unknown[] = [];
      let allParsed = textBlocks.length > 0;
      for (const t of textBlocks) {
        try {
          parsedTexts.push(JSON.parse(t));
        } catch {
          allParsed = false;
          break;
        }
      }
      const result: unknown = allParsed
        ? parsedTexts.length === 1
          ? parsedTexts[0]
          : parsedTexts
        : textBlocks.join('\n');
      if (toolUseId.length > 0) {
        patchToolCall(toolUseId, {
          result,
          ...(block.is_error === true ? { isError: true } : {}),
        });
      }
      // Sniff for ggui_render's renderId to mount the iframe entry.
      // Also handle ggui_update: result carries {renderId, updated:true}
      // — refresh the cached meta via /api/renders/:id/state.
      for (const text of textBlocks) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          /* not JSON */
        }
        if (!parsed) continue;
        // ggui_render branch — new render entering the chat log.
        // Spec-canonical: prefer the renderId over the
        // `url` field (R5 retired the public `/r/<shortCode>` URL).
        if (
          typeof parsed.renderId === 'string' &&
          parsed.updated !== true
        ) {
          const renderId = parsed.renderId;
          const item: RenderRef = {
            renderId,
            action: String(parsed.action ?? 'create'),
            ...(typeof parsed.contractHash === 'string'
              ? { contractHash: parsed.contractHash }
              : {}),
          };
          addRender(item);
          append({ id: `${baseId}.s${i}`, kind: 'render', render: item });
          // R5: recover the slice envelope via the wsToken-gated state
          // endpoint. The Anthropic SDK has already stripped `_meta`.
          // First call typically 401s (no wsToken yet) — that's expected;
          // the iframe shows a loading placeholder until ggui_update or
          // another render lands and a wsToken becomes available.
          void refetchStateById(renderId);
          continue;
        }
        // ggui_update branch — existing render gets new props. The
        // result envelope carries {renderId, updated:true}.
        // Re-fetch /state so AppRenderer sees a fresh `toolResult` /
        // `_meta` prop and forwards it to the inner iframe via the
        // spec-compliant `ui/notifications/tool-result` postMessage.
        if (
          parsed.updated === true &&
          typeof parsed.renderId === 'string'
        ) {
          void refetchStateById(parsed.renderId);
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
 * Stable per-tab chat-session id. Generated on first call, cached in
 * sessionStorage so a page refresh within the tab keeps the same id;
 * a fresh tab gets a fresh id. The server reads this off the
 * `X-Chat-Session-Id` header and keys its per-chat agent state on it,
 * so multi-turn flows preserve conversation history. SSR-safe: returns
 * a throwaway id when sessionStorage isn't available (test envs).
 */
const CHAT_SESSION_STORAGE_KEY = 'ggui-chat-session-id';
function getOrCreateChatSessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(CHAT_SESSION_STORAGE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    window.sessionStorage.setItem(CHAT_SESSION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // sessionStorage unavailable (SSR / privacy mode) — fall back to a
    // per-call id so the header is always populated. Trade-off: each
    // call looks like a fresh chat to the server, which degrades
    // multi-turn but never breaks single-turn.
    return crypto.randomUUID();
  }
}
