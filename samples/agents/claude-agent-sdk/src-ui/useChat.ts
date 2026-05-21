/* eslint-disable no-console */
import { useCallback, useRef, useState } from 'react';
import type { ChatEntry, StackItemRef, ToolCallEntry } from './types';

interface UseChatResult {
  readonly entries: ReadonlyArray<ChatEntry>;
  readonly stackItems: ReadonlyArray<StackItemRef>;
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
 */
export function useChat(): UseChatResult {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [stackItems, setStackItems] = useState<StackItemRef[]>([]);
  const [sending, setSending] = useState(false);
  // Mirror of the latest stackItems for the bootstrap-refetch lookup.
  // Plain state would close over the snapshot at handleEvent-call time;
  // the ref always reads current.
  const stackItemsRef = useRef<StackItemRef[]>([]);
  stackItemsRef.current = stackItems;
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

  /**
   * Patch the bootstrap field on an existing stack item by id. Used
   * by the bootstrap-refetch effect after every ggui_push and every
   * ggui_update tool_result. McpAppIframe's late-arrival forwarder
   * sees the prop transition and posts `ui/notifications/tool-result`
   * with the fresh `_meta.ggui.bootstrap` into the iframe — same path
   * the renderer's spec-compliant listener handles on initial mount.
   */
  const updateStackItemBootstrap = useCallback(
    (stackItemId: string, bootstrap: Record<string, unknown>) => {
      setStackItems((prev) => {
        const idx = prev.findIndex((p) => p.stackItemId === stackItemId);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx]!, bootstrap };
        return next;
      });
    },
    [],
  );

  /**
   * Async fetch of `/api/bootstrap/<shortCode>`. The shortCode is parsed
   * from a stack-item url like `<base>/r/<shortCode>`; the JSON endpoint
   * returns the full bootstrap envelope (live trio + componentCode +
   * propsJson + theme + capabilities). Recovers the field set the
   * Anthropic SDK strips from `tool_result._meta`.
   */
  const refetchBootstrap = useCallback(
    async (stackItemId: string, url: string) => {
      const shortCode = parseShortCodeFromUrl(url);
      if (!shortCode) return;
      try {
        const res = await fetch(`/api/bootstrap/${shortCode}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const bootstrap = (await res.json()) as Record<string, unknown>;
        updateStackItemBootstrap(stackItemId, bootstrap);
      } catch (err) {
        console.warn('[useChat] bootstrap refetch failed', err);
      }
    },
    [updateStackItemBootstrap],
  );

  /**
   * Refetch the bootstrap for an existing stack item by id. Looks up
   * the cached URL via the stackItems ref and dispatches the same
   * `/api/bootstrap/<shortCode>` fetch. Used by `ggui_update` results
   * which don't carry the URL — only `{sessionId, stackItemId}`.
   * No-op when no matching id is in state (the update lands before
   * the push registered the item — out-of-order delivery).
   */
  const refetchBootstrapById = useCallback(
    async (stackItemId: string) => {
      const item = stackItemsRef.current.find(
        (p) => p.stackItemId === stackItemId,
      );
      if (!item) return;
      await refetchBootstrap(stackItemId, item.url);
    },
    [refetchBootstrap],
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
          headers: { 'Content-Type': 'application/json' },
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
              patchToolCall,
              refetchBootstrap,
              refetchBootstrapById,
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
      patchToolCall,
      refetchBootstrap,
      refetchBootstrapById,
    ],
  );

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  return { entries, stackItems, sending, send, abort };
}

function handleEvent(
  eventType: string,
  payload: unknown,
  baseId: string,
  append: (e: ChatEntry) => void,
  addStackItem: (s: StackItemRef) => void,
  patchToolCall: (
    toolUseId: string,
    patch: { readonly result?: unknown; readonly isError?: boolean },
  ) => void,
  refetchBootstrap: (stackItemId: string, url: string) => Promise<void>,
  refetchBootstrapById: (stackItemId: string) => Promise<void>,
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
    // expand UI shows full call+result side-by-side, and (b) sniff for
    // a `url` to spawn a stack-item entry (the rendered iframe).
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
      // Sniff for ggui_push's renderer URL to mount the iframe entry.
      // Also handle ggui_update: the result carries no `url` but does
      // carry `{sessionId, stackItemId, updated:true}` — we look up the
      // matching iframe and refetch its bootstrap so the live mount
      // re-applies post-patch state via spec-compliant postMessage.
      for (const text of textBlocks) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          /* not JSON */
        }
        if (!parsed) continue;
        // ggui_push branch: new stack item entering the chat log.
        if (typeof parsed.url === 'string') {
          const item: StackItemRef = {
            stackItemId: String(parsed.stackItemId ?? `unknown-${i}`),
            sessionId: String(parsed.sessionId ?? ''),
            url: parsed.url,
            action: String(parsed.action ?? 'create'),
            ...(typeof parsed.contractHash === 'string'
              ? { contractHash: parsed.contractHash }
              : {}),
          };
          addStackItem(item);
          append({ id: `${baseId}.s${i}`, kind: 'stack-item', stackItem: item });
          // Side-effect fetch of `/api/bootstrap/<shortCode>` — the
          // Anthropic SDK has already stripped `_meta` from the result,
          // so we recover the envelope from the server-side JSON path.
          // McpAppIframe's late-arrival path posts it to the iframe on
          // bootstrap-prop transition.
          void refetchBootstrap(item.stackItemId, item.url);
          continue;
        }
        // ggui_update branch: existing stack item gets new props. The
        // result envelope doesn't carry the URL (only {sessionId,
        // stackItemId, updated}). Look up the cached URL via the
        // stackItemsRef helper + refetch the bootstrap so the post-
        // patch propsJson reaches the still-mounted iframe via
        // McpAppIframe's late-arrival postMessage path.
        if (
          parsed.updated === true &&
          typeof parsed.stackItemId === 'string'
        ) {
          void refetchBootstrapById(parsed.stackItemId);
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
 * Pull the shortCode out of a stack-item URL. The render path is
 * `<base>/r/<shortCode>` so we match the last path segment after `/r/`.
 * Returns null on shape mismatch (e.g. someone passes a non-render URL).
 */
function parseShortCodeFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, 'http://localhost');
    const match = parsed.pathname.match(/\/r\/([^/?#]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

