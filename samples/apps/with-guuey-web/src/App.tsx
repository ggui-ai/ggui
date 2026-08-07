import { type JSX, useMemo, useState } from 'react';
import { AppRenderer } from '@mcp-ui/client';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ThemeProvider, getRawTheme } from '@ggui-ai/design/themes';
import { useAgentInvoke } from '@guuey/agent-client/react';
import {
  AgentResponseError,
  createWebAdapters,
  resourceHtml,
  toolNameFor,
  toolResultCardMount,
  toolResultGguiRender,
  type AgentInvokeAdapters,
  type AgMessage,
  type CardMount,
  type GguiRenderBootstrap,
  type InvokeRequest,
} from '@guuey/agent-client';

/**
 * platform-composed (guuey-sdk) chat shell — the web half of the composed
 * golden path. Replaces the role `ggui-basic-web`'s 702-line hand-rolled
 * `Chat.tsx` plays in the framework-native lanes: `useAgentInvoke` owns the
 * SSE fold and per-turn lifecycle, and `@guuey/agent-client`'s card-mount
 * dispatcher owns generative-UI recognition — this file only renders.
 */

/** guuey dev router base — `guuey dev --serve` binds 127.0.0.1:6790 by default. */
const ENDPOINT = import.meta.env.VITE_GUUEY_ENDPOINT ?? 'http://localhost:6790';
/** Matches `appId` in the agent half's guuey.json; namespaces the thread key. */
const APP_ID = import.meta.env.VITE_GUUEY_APP_ID ?? 'ggui-golden-path';
/** Second-origin sandbox host page — injected by vite.config.ts (`define`). */
const SANDBOX_URL = import.meta.env.VITE_SANDBOX_URL;

/**
 * Same theme pairing as ggui-basic-web: the chat chrome uses the theme the
 * iframe content uses (`samples/gguis/default` sets `indigo / dark`).
 */
const INDIGO_DARK = getRawTheme('indigo', 'dark');

/**
 * Anonymous SSE transport for `guuey dev --serve`.
 *
 * `createWebAdapters()`'s own transport always attaches exactly ONE identity
 * carrier — a `Authorization: Bearer`, an `x-guuey-guest` header, or cookie
 * credentials (`credentials: "include"`, its no-resolver fallback). The
 * published dev router (`@guuey/cli` 0.2.0) answers CORS with
 * `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Headers:
 * Content-Type` and never sets `Access-Control-Allow-Credentials`, so all
 * three carriers fail the browser's cross-origin checks (wildcard origin +
 * credentials is blocked outright; the two headers are not in the allow
 * list). The dev router is anonymous-only anyway (`authMode: "anonymous"`
 * on its session frame), so the honest transport for it is a
 * credential-less fetch: same streaming contract as the package's
 * `fetchStreamTransport`, minus the identity carriers. Storage + id
 * generation still come from `createWebAdapters()` below — the transport is
 * the ONE adapter the dev router needs swapped, via the injection seam the
 * package ships for exactly this.
 */
async function* devInvokeTransport(req: InvokeRequest): AsyncGenerator<string> {
  const resp = await fetch(req.url, {
    method: 'POST',
    signal: req.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(req.body),
  });
  if (!resp.ok || !resp.body) {
    // The dev router's non-2xx body is `{ error }` JSON — surface it, with
    // the bare status as fallback for non-JSON failures.
    const body: unknown = await resp.json().catch(() => null);
    let message = `agent responded ${resp.status}`;
    if (
      body !== null &&
      typeof body === 'object' &&
      'error' in body &&
      typeof body.error === 'string' &&
      body.error.length > 0
    ) {
      message = body.error;
    }
    throw new AgentResponseError(message, resp.status);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}

const webAdapters = createWebAdapters();
const adapters: AgentInvokeAdapters = {
  storage: webAdapters.storage,
  generateId: webAdapters.generateId,
  transport: devInvokeTransport,
};

/**
 * One agent turn as folded from the AgJSON transcript: the assistant text
 * plus the tool names the turn invoked (rendered as activity chips).
 */
interface AssistantTurn {
  key: string;
  text: string;
  tools: string[];
}

/**
 * Group the fold's messages into per-turn assistant output, in first-seen
 * turn order. The dev router runs one turn per invoke, so turn N pairs with
 * the user's Nth message (the zip in `Transcript` below). Text is taken
 * from assistant-role messages only — tool-role messages carry tool-result
 * payloads, not prose.
 */
function foldAssistantTurns(foldMessages: AgMessage[]): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  const indexByTurn = new Map<string, number>();
  for (const m of foldMessages) {
    const turnKey = m.turnId ?? m.id;
    let i = indexByTurn.get(turnKey);
    if (i === undefined) {
      i = turns.length;
      indexByTurn.set(turnKey, i);
      turns.push({ key: turnKey, text: '', tools: [] });
    }
    const turn = turns[i];
    for (const block of m.content) {
      if (block.type === 'text' && m.role === 'assistant') {
        turn.text += block.text;
      } else if (block.type === 'tool-call') {
        turn.tools.push(block.name);
      }
    }
  }
  return turns;
}

/** A mountable generative-UI card recognised on the fold, ready to render. */
interface MountedCard {
  /** The render's real resource uri — stable React key. */
  key: string;
  toolName: string;
  mount: CardMount;
  /**
   * CSP domains for the sandbox page — present only on the ggui channel,
   * whose shell must load ggui's runtime bundle and open its WebSocket
   * (an inline card is self-contained HTML and needs no exceptions).
   */
  csp?: { resourceDomains: string[]; connectDomains: string[] };
}

/**
 * Derive the sandbox CSP a ggui shell needs from its own bootstrap slice:
 * the runtime-bundle origin (script/resource load) and the live-channel
 * origins (`connect-src`). Nothing is hardcoded — whatever origins the
 * runtime MCP put on the wire are the origins the sandbox page allows.
 */
function gguiCsp(bootstrap: GguiRenderBootstrap): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const resource = new Set<string>();
  const connect = new Set<string>();
  const add = (value: unknown, sets: Set<string>[]): void => {
    // Structural gate on wire data (the runtime's projector is the slice
    // authority; unparseable entries simply contribute no CSP exception).
    if (typeof value !== 'string' || value.length === 0 || !URL.canParse(value)) return;
    const origin = new URL(value).origin;
    for (const s of sets) s.add(origin);
  };
  add(bootstrap.runtimeUrl, [resource, connect]);
  add(bootstrap.slice.codeUrl, [resource, connect]);
  add(bootstrap.slice.wsUrl, [connect]);
  return { resourceDomains: [...resource], connectDomains: [...connect] };
}

/**
 * Walk the fold for generative-UI cards through the package's card-mount
 * dispatcher (`toolResultCardMount` — inline mcp-ui resources first, ggui
 * renders second, one `McpUiResourcePayload` out either way). For ggui
 * mounts, re-narrow the descriptor to reach the bootstrap the CSP needs.
 */
function foldCards(foldMessages: AgMessage[]): MountedCard[] {
  const cards: MountedCard[] = [];
  for (const m of foldMessages) {
    for (const block of m.content) {
      if (block.type !== 'tool-result') continue;
      const mount = toolResultCardMount(block);
      if (!mount) continue;
      const bootstrap =
        mount.channel === 'ggui' ? toolResultGguiRender(block)?.bootstrap : undefined;
      cards.push({
        key: mount.resource.uri,
        toolName: toolNameFor(m, block.toolCallId),
        mount,
        ...(bootstrap ? { csp: gguiCsp(bootstrap) } : {}),
      });
    }
  }
  return cards;
}

export function App(): JSX.Element {
  const {
    messages,
    send,
    status,
    activeTool,
    error,
    threadId,
    abort,
    reset,
    reduceResult,
  } = useAgentInvoke({
    endpointUrl: ENDPOINT,
    appId: APP_ID,
    adapters,
    // The dev router streams silver AgJSON batches; the block-preserving
    // fold is the transcript + card surface for them (see Transcript).
    preserveBlocks: true,
  });

  const [draft, setDraft] = useState('');

  const assistantTurns = useMemo(
    () => (reduceResult ? foldAssistantTurns(reduceResult.messages) : []),
    [reduceResult],
  );
  const cards = useMemo(
    () => (reduceResult ? foldCards(reduceResult.messages) : []),
    [reduceResult],
  );
  // Panel shows the newest card — same top-card rule as ggui-basic-web.
  const top = cards.length > 0 ? cards[cards.length - 1] : undefined;

  const sandbox = useMemo(() => {
    if (!top) return undefined;
    return top.csp
      ? { url: new URL(SANDBOX_URL), csp: top.csp }
      : { url: new URL(SANDBOX_URL) };
  }, [top]);

  const statusLabel =
    status === 'using-tool' && activeTool !== null ? `using tool: ${activeTool}` : status;

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0 || status !== 'ready') return;
    setDraft('');
    void send(text);
  };

  const html = top ? resourceHtml(top.mount.resource) : undefined;

  return (
    <ThemeProvider theme={INDIGO_DARK} mode="dark">
      <div className="shell">
        <header className="topbar">
          <span className="title">with-guuey golden path</span>
          <span className="badge">platform-composed (guuey-sdk)</span>
          <span className="endpoint">
            agent: <code>{ENDPOINT}</code>
            {threadId !== null ? (
              <>
                {' '}
                · thread <code>{threadId.slice(0, 12)}</code>
              </>
            ) : null}
          </span>
        </header>
        <main className="columns">
          <section className="chat">
            <div className="transcript" data-testid="transcript">
              {messages.length === 0 ? (
                <p className="hint">
                  Ask for your todo list — the agent renders it as a live ggui
                  card in the panel on the right.
                </p>
              ) : null}
              <Transcript
                messages={messages}
                assistantTurns={assistantTurns}
                silver={reduceResult !== null}
              />
            </div>
            {error !== null ? (
              <div className="error" role="alert">
                {error}
              </div>
            ) : null}
            <div className="status" data-status={status}>
              {statusLabel}
            </div>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Show me my todo list…"
                aria-label="Message the agent"
              />
              <button type="submit" disabled={status !== 'ready' || draft.trim().length === 0}>
                Send
              </button>
              {status !== 'ready' ? (
                <button type="button" onClick={abort}>
                  Stop
                </button>
              ) : (
                <button type="button" onClick={reset} disabled={messages.length === 0}>
                  Reset
                </button>
              )}
            </form>
          </section>
          <aside className="panel">
            {top !== undefined && html !== undefined && sandbox !== undefined ? (
              <div className="render">
                <div className="render-chrome">
                  <span className="render-tool">{top.toolName}</span>
                  <span className="render-channel">{top.mount.channel}</span>
                </div>
                <div className="render-frame">
                  <AppRenderer
                    key={top.key}
                    toolName={top.toolName}
                    sandbox={sandbox}
                    html={html}
                    onCallTool={defensiveCallTool}
                    onError={(err) => console.warn('[with-guuey-web] AppRenderer error', err)}
                  />
                </div>
              </div>
            ) : (
              <div className="ui-placeholder">
                <p>The rendered UI will appear here once the agent emits one.</p>
              </div>
            )}
          </aside>
        </main>
      </div>
    </ThemeProvider>
  );
}

/**
 * The guest UI's interactions ride ggui's own WebSocket (the live channel
 * in the card's bootstrap) — `guuey dev --serve` exposes no tools/call
 * relay route this host could forward to. If a guest ever asks anyway,
 * answer honestly instead of hanging.
 */
async function defensiveCallTool(params: CallToolRequest['params']): Promise<CallToolResult> {
  console.warn('[with-guuey-web] guest tools/call has no relay under guuey dev:', params.name);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          'guuey dev serves no tools/call relay; ggui card interactions ride ' +
          'the ggui live channel (WebSocket) instead.',
      },
    ],
  };
}

/**
 * The transcript rows.
 *
 * Under the dev router the `message` frames are silver AgJSON BATCHES
 * (arrays), which the hook's flat text fold reduces to "" — the
 * block-preserving fold (`reduceResult`) is the real assistant surface, so
 * when it is live (`silver`) the rows zip the user's optimistic turns with
 * the fold's per-turn output. Against a single-object-frame producer (the
 * hosted pod, or a bypass-protocol config) `reduceResult` stays null and
 * the flat `messages` render as-is.
 */
function Transcript({
  messages,
  assistantTurns,
  silver,
}: {
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  assistantTurns: AssistantTurn[];
  silver: boolean;
}): JSX.Element {
  if (!silver) {
    return (
      <>
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
          </div>
        ))}
      </>
    );
  }
  const userTurns = messages.filter((m) => m.role === 'user');
  const rows: JSX.Element[] = [];
  const count = Math.max(userTurns.length, assistantTurns.length);
  for (let i = 0; i < count; i++) {
    const user = userTurns[i];
    if (user !== undefined) {
      rows.push(
        <div key={`u${i}`} className="bubble user">
          {user.text}
        </div>,
      );
    }
    const turn = assistantTurns[i];
    if (turn !== undefined && (turn.text.length > 0 || turn.tools.length > 0)) {
      rows.push(
        <div key={`a${turn.key}`} className="bubble assistant">
          {turn.tools.length > 0 ? (
            <div className="chips">
              {turn.tools.map((name, j) => (
                <span key={j} className="chip">
                  {name}
                </span>
              ))}
            </div>
          ) : null}
          {turn.text}
        </div>,
      );
    }
  }
  return <>{rows}</>;
}
