import { type JSX, useEffect, useMemo, useState } from 'react';
import { AppRenderer } from '@mcp-ui/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  type CallToolRequest,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ThemeProvider, getRawTheme } from '@ggui-ai/design/themes';
import { useAgentInvoke } from '@guuey/agent-client/react';
import {
  AgentResponseError,
  createWebAdapters,
  toolNameFor,
  type AgentInvokeAdapters,
  type AgMessage,
  type InvokeRequest,
} from '@guuey/agent-client';
import {
  createMcpUiResourceReader,
  resourceHtml,
  toolResultViewMount,
  uiResourceChannel,
  type McpUiResourceCsp,
  type ResolvedViewMount,
  type ViewMount,
} from '@guuey/mcp-apps-host';

/**
 * platform-composed (guuey-sdk) chat shell — the web half of the composed
 * golden path. Replaces the role `ggui-basic-web`'s 702-line hand-rolled
 * `Chat.tsx` plays in the framework-native lanes: `useAgentInvoke` owns the
 * SSE fold and per-turn lifecycle, and `@guuey/mcp-apps-host`'s view-mount
 * dispatcher owns generative-UI recognition — this file only renders, plus
 * the two obligations the MCP Apps Host role leaves with the host: the guest
 * `tools/call` relay and `ui://` locator rehydration (both over ONE MCP
 * client to ggui serve — see `gguiRelayClient`).
 */

/** guuey dev router base — `guuey dev --serve` binds 127.0.0.1:6790 by default. */
const ENDPOINT = import.meta.env.VITE_GUUEY_ENDPOINT ?? 'http://localhost:6790';
/**
 * ggui serve's MCP endpoint as the BROWSER reaches it — the target of
 * this host's guest tools/call relay. Defaults to the same-origin
 * `/ggui-mcp` dev proxy (vite.config.ts), which keeps the sample
 * configuration-free. Serve also supports a direct cross-origin URL when
 * the operator allowlists this page's origin
 * (`ggui serve --browser-origin http://localhost:6890`) — set
 * `VITE_GGUI_MCP_URL` to the absolute `/mcp` URL to use that path.
 */
const GGUI_MCP_URL = import.meta.env.VITE_GGUI_MCP_URL ?? '/ggui-mcp';
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
 * published dev router (`@guuey/cli` 0.3.0) answers CORS with
 * `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Headers:
 * Content-Type, Authorization, x-guuey-guest` and still never sets
 * `Access-Control-Allow-Credentials`. The two HEADER carriers would now pass
 * the preflight (0.3.0 widened the allow list for its history reads), but
 * this app configures neither resolver — the dev router is anonymous-only
 * (`authMode: "anonymous"` on its session frame), and claiming a bearer or
 * minting a guest secret purely to steer the transport off its cookie arm
 * would put an identity on the wire the router ignores. Without a resolver
 * the package transport falls to cookie credentials, which the wildcard
 * origin blocks outright — so the honest transport for the dev router is
 * still a credential-less fetch: same streaming contract as the package's
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

/** Sandbox-CSP origin lists for a ggui-channel mount. */
interface SandboxCsp {
  resourceDomains: string[];
  connectDomains: string[];
}

/** A generative-UI card recognised on the fold (or restored from a persisted
 *  locator), ready to render — or, on the `locator` arm, ready to RESOLVE:
 *  a locator carries no mount material, only the durable `ui://` identity
 *  the reader re-fetches fresh material for (see `readUiResource`). */
interface MountedCard {
  /** The render's real resource uri — stable React key AND the locator. */
  key: string;
  toolName: string;
  mount: ViewMount;
}

/**
 * Sandbox CSP for a ggui-channel mount, read from the WIRE: the server
 * declares `_meta.ui.csp.{connectDomains,resourceDomains}` (MCP Apps
 * spec) on every per-render `resources/read` result, and the reader
 * surfaces the schema-validated declaration as `mount.csp`. Nothing is
 * derived or hardcoded client-side — whatever origins the runtime MCP
 * declared are the origins the sandbox page allows. Vendor-neutral:
 * this works against ANY MCP-Apps server that declares CSP.
 */
function sandboxCspFromWire(csp: McpUiResourceCsp | undefined): SandboxCsp | undefined {
  if (csp === undefined) return undefined;
  return {
    resourceDomains: [...(csp.resourceDomains ?? [])],
    connectDomains: [...(csp.connectDomains ?? [])],
  };
}

/**
 * Walk the fold for generative-UI cards through the host package's
 * view-mount dispatcher (`toolResultViewMount` — an inline mcp-ui
 * resource, else a bare `ui://` LOCATOR when a block carries the
 * durable identity but no mount material). Cards carry NO trust
 * material: the sandbox CSP arrives on the RESOLVED mount
 * (`mount.csp`, the server's wire declaration) once the panel resolves
 * a locator through `readUiResource` — see `sandboxCspFromWire`.
 */
function foldCards(foldMessages: AgMessage[]): MountedCard[] {
  const cards: MountedCard[] = [];
  for (const m of foldMessages) {
    for (const block of m.content) {
      if (block.type !== 'tool-result') continue;
      const mount = toolResultViewMount(block);
      if (!mount) continue;
      cards.push({
        key: mount.channel === 'locator' ? mount.resourceUri : mount.resource.uri,
        toolName: toolNameFor(m, block.toolCallId),
        mount,
      });
    }
  }
  return cards;
}

/**
 * The last mounted ggui card's rehydration memento, persisted in
 * `localStorage` (keyed per app, beside the SDK's own threadId store).
 *
 * WHY THE HOST PERSISTS THIS: a card's durable identity is its `ui://`
 * locator — rehydration is a fresh `resources/read` of that uri, never a
 * replay of stored mount material (whose live-channel credentials expire
 * with the page). The dev router's history rows are text-only, so the
 * locator has to survive somewhere the HOST owns; this sample keeps it in
 * `localStorage`.
 *
 * The memento stores NO trust material: sandbox-CSP origins arrive on the
 * WIRE with every `resources/read` (`_meta.ui.csp`, surfaced as
 * `mount.csp` by the reader), so a rehydrated locator re-learns its trust
 * from the fresh read — per card, spec-declared, never persisted state
 * that could go stale against a redeployed runtime.
 */
interface CardMemento {
  /** The persisted `ui://` locator — the render's durable identity. */
  resourceUri: string;
  /** The tool that produced the render (panel chrome only). */
  toolName: string;
}

const CARD_MEMENTO_KEY = `with-guuey-web:card:${APP_ID}`;

/** Structural gate for a stored memento — a corrupt or foreign entry reads
 *  as "no memento" (the same posture as a reader miss: placeholder, never
 *  an error surface). The locator must be `ui://ggui/` specifically, not
 *  just `ui://` — the restore path is for ggui renders; any other uri
 *  resolves through the reader as the `inline` channel anyway. */
function parseCardMemento(raw: string): CardMemento | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // corrupt entry == no memento
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  if (!('resourceUri' in parsed) || typeof parsed.resourceUri !== 'string') return undefined;
  if (!parsed.resourceUri.startsWith('ui://ggui/')) return undefined;
  if (!('toolName' in parsed) || typeof parsed.toolName !== 'string') return undefined;
  return {
    resourceUri: parsed.resourceUri,
    toolName: parsed.toolName,
  };
}

/** The restored card for a persisted memento: a `locator` mount the reader
 *  resolves on demand — deliberately NOT stored mount material; its
 *  sandbox trust arrives on the fresh read (`mount.csp`). */
function restoredCardFromStorage(): MountedCard | undefined {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(CARD_MEMENTO_KEY);
  } catch {
    return undefined; // private mode / blocked storage — nothing to restore
  }
  if (raw === null) return undefined;
  const memento = parseCardMemento(raw);
  if (memento === undefined) return undefined;
  return {
    key: memento.resourceUri,
    toolName: memento.toolName,
    mount: { channel: 'locator', resourceUri: memento.resourceUri },
  };
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
  // The card restored from the persisted locator memento, if any — read once
  // at mount. Live fold cards take precedence; Reset clears it (see resetAll).
  const [restored, setRestored] = useState<MountedCard | undefined>(restoredCardFromStorage);
  // Panel shows the newest card — same top-card rule as ggui-basic-web —
  // falling back to the restored locator card while the fold is empty.
  const top = cards.length > 0 ? cards[cards.length - 1] : restored;

  // Read-door resolution — TWO cases go through the reader, once per uri:
  //   1. A bare `ui://` locator (a restored card, or a live fold whose
  //      `_meta` never reached us) — it has no mount material at all.
  //   2. An INLINE-embedded resource whose uri classifies as the ggui
  //      channel (`uiResourceChannel`): servers like `ggui serve` embed
  //      the render in the tool result, but the dispatcher deliberately
  //      never labels an embed 'ggui' — the channel AND the sandbox
  //      trust both come from the read door (`mount.csp`, the wire's
  //      `_meta.ui.csp` declaration). A fresh read of the same uri
  //      yields the same material PLUS the declared CSP, so ggui cards
  //      always mount read-door-resolved, spec-consistently.
  // `null` records a miss — deny == miss == placeholder, never an error
  // surface, and no retry loop (a fresh mount or reload asks again).
  const [resolved, setResolved] = useState<Record<string, ResolvedViewMount | null>>({});
  const topNeedsRead =
    top !== undefined &&
    (top.mount.channel === 'locator' ||
      (top.mount.channel === 'inline' &&
        uiResourceChannel(top.mount.resource.uri) === 'ggui'));
  const pendingLocator =
    top !== undefined && topNeedsRead && resolved[top.key] === undefined ? top.key : undefined;
  useEffect(() => {
    if (pendingLocator === undefined) return undefined;
    let cancelled = false;
    // The reader never rejects — transport failures resolve `undefined`
    // (the package's deny == miss rule), recorded here as a miss.
    void readUiResource(pendingLocator).then((mount) => {
      if (cancelled) return;
      setResolved((prev) => ({ ...prev, [pendingLocator]: mount ?? null }));
    });
    return () => {
      cancelled = true;
    };
  }, [pendingLocator]);

  // The material actually mounted: non-ggui inline arms mount as-is; a
  // locator OR a ggui-uri embed mounts its reader result once resolved
  // (placeholder until then, and on a miss).
  const material: ResolvedViewMount | undefined =
    top === undefined
      ? undefined
      : !topNeedsRead && top.mount.channel === 'inline'
        ? top.mount
        : (resolved[top.key] ?? undefined);

  // Persist the newest ggui card's locator as the rehydration memento
  // (see CardMemento) — written once the material RESOLVES to the ggui
  // channel (the reader's uri-derived classification), which is also
  // the moment its wire-declared CSP proved the locator mounts.
  // Serialized in the memo so the write effect keys on VALUE — the fold
  // rebuilds card objects every frame, but the JSON only changes when
  // the card does.
  const mementoJson = useMemo(() => {
    if (top === undefined || material === undefined) return undefined;
    if (material.channel !== 'ggui') return undefined;
    const memento: CardMemento = {
      resourceUri: material.resource.uri,
      toolName: top.toolName,
    };
    return JSON.stringify(memento);
  }, [top, material]);
  useEffect(() => {
    if (mementoJson === undefined) return;
    try {
      window.localStorage.setItem(CARD_MEMENTO_KEY, mementoJson);
    } catch {
      // Private mode / blocked storage: rehydration simply won't survive a
      // reload — the same silent degradation as the SDK's own threadId store.
    }
  }, [mementoJson]);

  // `foldCards` re-runs on every AgJSON frame (each `reduceResult` update),
  // so mount objects get a FRESH identity per frame even when the card is
  // unchanged. AppRenderer's send-html effect depends on `sandbox.csp` by
  // identity and re-sends `ui/notifications/sandbox-resource-ready` when
  // it changes, which the sandbox page answers with
  // doc.open()/write()/close() — a full reboot of the mounted ggui shell
  // (flicker, in-card state loss, a fresh WS bootstrap). So the sandbox
  // prop must be VALUE-keyed: fingerprint the CSP origin lists into
  // primitives (URL origins cannot contain spaces) and rebuild the object
  // only when the card or its declared CSP values actually change.
  //
  // Applied trust = the RESOLVED material's own wire declaration
  // (`material.csp`, the server's `_meta.ui.csp` surfaced by the reader),
  // applied ONLY when the material on screen is the ggui channel — the
  // package derives a mount's channel from the uri it resolved, and this
  // host does not override that decision.
  const topKey = top?.key;
  const wireCsp = material?.channel === 'ggui' ? sandboxCspFromWire(material.csp) : undefined;
  const wireResourceOrigins = wireCsp?.resourceDomains.join(' ');
  const wireConnectOrigins = wireCsp?.connectDomains.join(' ');
  const sandbox = useMemo(() => {
    if (topKey === undefined) return undefined;
    const url = new URL(SANDBOX_URL);
    // Origin lists apply only when the resolved material IS the ggui
    // channel AND the server declared them on the read (see the note
    // above) — an inline card is self-contained HTML, no exceptions.
    if (wireResourceOrigins === undefined || wireConnectOrigins === undefined) {
      return { url };
    }
    return {
      url,
      csp: {
        resourceDomains: wireResourceOrigins.length > 0 ? wireResourceOrigins.split(' ') : [],
        connectDomains: wireConnectOrigins.length > 0 ? wireConnectOrigins.split(' ') : [],
      },
    };
  }, [topKey, wireResourceOrigins, wireConnectOrigins]);

  const statusLabel =
    status === 'using-tool' && activeTool !== null ? `using tool: ${activeTool}` : status;

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0 || status !== 'ready') return;
    setDraft('');
    void send(text);
  };

  const resetAll = (): void => {
    // Reset is a full fresh start: drop the persisted card memento and the
    // restored card too, not just the transcript.
    try {
      window.localStorage.removeItem(CARD_MEMENTO_KEY);
    } catch {
      // Blocked storage: nothing was persisted to drop.
    }
    setRestored(undefined);
    reset();
  };

  const html = material !== undefined ? resourceHtml(material.resource) : undefined;

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
                <button
                  type="button"
                  onClick={resetAll}
                  disabled={messages.length === 0 && top === undefined}
                >
                  Reset
                </button>
              )}
            </form>
          </section>
          <aside className="panel">
            {top !== undefined &&
            material !== undefined &&
            html !== undefined &&
            sandbox !== undefined ? (
              <div className="render">
                <div className="render-chrome">
                  <span className="render-tool">{top.toolName}</span>
                  <span className="render-channel">{material.channel}</span>
                </div>
                <div className="render-frame">
                  <AppRenderer
                    key={top.key}
                    toolName={top.toolName}
                    sandbox={sandbox}
                    html={html}
                    onCallTool={relayCallTool}
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
 * Guest tools/call relay — the MCP-Apps HOST OBLIGATION this shell
 * carries for its mounted cards. The card's runtime dispatches user
 * actions as guest `tools/call` (`ggui_runtime_submit_action`) through
 * its host; the live-channel WebSocket carries server→card updates,
 * NOT card→server actions. A host that drops the relay silently
 * swallows every card interaction (the toggle-never-round-tripped
 * class, ggui#426): the runtime shows "transport error" and the
 * server's eventSequence stays 0 forever.
 *
 * The relay is a lazy singleton MCP client straight to ggui serve —
 * `guuey dev` holds its own connection to the same endpoint for the
 * agent's tools; this one is the HOST's, for guest calls.
 */
let relayClientPromise: Promise<Client> | null = null;

function gguiRelayClient(): Promise<Client> {
  relayClientPromise ??= (async () => {
    const client = new Client({ name: 'with-guuey-web-host-relay', version: '0.0.1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(GGUI_MCP_URL, window.location.origin)),
    );
    return client;
  })().catch((err: unknown) => {
    // Failed connects must not poison every later call — clear the
    // slot so the next guest call retries the connect.
    relayClientPromise = null;
    throw err;
  });
  return relayClientPromise;
}

async function relayCallTool(params: CallToolRequest['params']): Promise<CallToolResult> {
  try {
    const client = await gguiRelayClient();
    return CallToolResultSchema.parse(await client.callTool(params));
  } catch (err) {
    console.warn('[with-guuey-web] guest tools/call relay failed:', params.name, err);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `host relay to ggui serve (${GGUI_MCP_URL}) failed: ${String(err)}`,
        },
      ],
    };
  }
}

/**
 * Locator rehydration — the OTHER host obligation this shell carries (the
 * guest tools/call relay above is the first). The host package's generic
 * reader, assembled over the SAME MCP client the relay holds: one fresh
 * `resources/read` of a persisted `ui://` locator. The package's trust
 * rules apply as shipped — a deny, a miss, and a transport error all
 * resolve `undefined` (the panel keeps its placeholder), and the sandbox
 * channel derives from the REQUESTED uri, never from the response. ggui
 * serve answers the read with a freshly minted shell for the render's
 * CURRENT state — fresh live-channel credentials included — so a
 * rehydrated card comes back live; stored mount material is never
 * replayed.
 */
const readUiResource = createMcpUiResourceReader({
  readResource: async (uri) => {
    const client = await gguiRelayClient();
    const result = await client.readResource({ uri });
    const first = result.contents[0];
    if (first === undefined) return undefined;
    return {
      uri: first.uri,
      ...(typeof first.mimeType === 'string' ? { mimeType: first.mimeType } : {}),
      ...('text' in first && typeof first.text === 'string' ? { text: first.text } : {}),
      ...('blob' in first && typeof first.blob === 'string' ? { blob: first.blob } : {}),
      // The contents entry's `_meta` MUST ride along: the server's
      // per-resource CSP declaration (`_meta.ui.csp`, MCP Apps spec)
      // lives here, and the reader's schema-validated door
      // (`declaredResourceCsp`) surfaces it as `mount.csp` — the
      // sandbox trust this host applies. Dropping it silently strips
      // the card's CSP and the shell mounts blind.
      ...('_meta' in first ? { _meta: first._meta } : {}),
    };
  },
});

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
