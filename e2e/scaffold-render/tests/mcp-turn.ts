/**
 * Browserless MCP turn-driver for the scaffold-render sub-tier-B specs.
 *
 * Talks DIRECTLY to a scaffolded app's `ggui serve` HTTP/MCP endpoint (no
 * browser): `ggui_handshake` → `ggui_render`, parsing both the JSON and SSE
 * transport shapes. Inlined (rather than importing the journeys harness) so the
 * Verdaccio sub-tier-B specs stay dependency-free — they speak to the published
 * app's own ggui server, not a workspace-spawned one, and pull in no import-time
 * filesystem-walking helpers.
 *
 * Not a spec — no `.spec.`/`.test.` suffix, so Playwright's testMatch skips it.
 */

// --dev-allow-all accepts any non-empty bearer as `builder`.
export const DEV_BEARER = 'dev';

// MCP JSON-RPC envelope. `result` is the CallToolResult — a per-tool shape, so
// Record<string, unknown> is the honest transport-boundary type (the same shape
// the journeys ggui-serve-harness uses); callers narrow it with the named
// result interfaces below.
export interface McpEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Validator finding on the suggestion (only the read fields). */
export interface SuggestionFinding {
  code: string;
  severity: string;
  path: string;
  message: string;
}

/** Handshake suggestion (the bits the specs read). */
export interface HandshakeSuggestion {
  origin?: string;
  proposedContractSummary?: string;
  validationFindings?: SuggestionFinding[];
}

/** ggui_handshake CallToolResult (the bits the specs read). */
export interface HandshakeResult {
  structuredContent?: { handshakeId?: string; suggestion?: HandshakeSuggestion };
}

/**
 * Reuse-outcome marker on `ggui_render`'s `renderCacheMarkerSchema`. Mirrored
 * locally (rather than imported from `@ggui-ai/protocol`) to keep this
 * Verdaccio sub-tier-B harness dependency-free — same transport-boundary stance
 * as the `Record<string, unknown>` envelope above. Only the read fields are
 * modeled.
 */
export interface RenderCacheMarker {
  hit: boolean;
  similarity?: number;
  cachedBlueprintId?: string;
  llmCallsAvoided: number;
  kind?: 'full-template' | 'cold';
}

/**
 * ggui_render CallToolResult (the bits the specs check). `blueprintId` +
 * `variantKey` + `contractHash` + `cache` are the reuse-visibility fields
 * surfaced on `renderOutputSchema`.
 */
export interface GguiSessionResult {
  isError?: boolean;
  sessionId?: string;
  action?: string;
  blueprintId?: string;
  variantKey?: string;
  contractHash?: string;
  cache?: RenderCacheMarker;
}

/** ggui_render CallToolResult envelope — structured fields ride on `structuredContent`. */
export interface RenderCallResult {
  isError?: boolean;
  structuredContent?: GguiSessionResult;
}

/** Local mirror of the protocol BlueprintVariance (kept dependency-free). */
export interface Variance {
  persona?: string;
  aesthetic?: string;
  context?: Record<string, unknown>;
  seedPrompt?: string;
}

/** Local mirror of the ggui_render `override?` input. */
export interface RenderOverride {
  contract?: unknown;
  variance?: Variance;
}

/** The parsed render output, the handshake suggestion, and the wall-clock ms. */
export interface GguiSessionOnceResult extends GguiSessionResult {
  ms: number;
  suggestion?: HandshakeSuggestion;
}

/**
 * Per-call MCP transport options.
 *
 *  - `bearer` — the `Authorization: Bearer <…>` value. Defaults to
 *    {@link DEV_BEARER} (`'dev'`), which the local scaffolded `ggui serve
 *    --dev-allow-all` accepts as `builder`. The cross-deployment persistence
 *    capstone (cloud Phase B) passes a real app-scoped `ggui_user_*` key here.
 *  - `mcpPath` — the path segment appended to `gguiUrl`. Defaults to `'/mcp'`
 *    (the OSS `ggui serve` convention). The deployed cloud pod mounts MCP at
 *    the bare root of its per-app endpoint (`/apps/<appId>`), so cloud callers
 *    pass `mcpPath: ''`.
 *
 * Both default to the existing local-scaffold behavior — back-compat for the
 * sub-tier-B scaffold-render callers, which omit `opts` entirely.
 */
export interface McpTransportOpts {
  readonly bearer?: string;
  readonly mcpPath?: string;
}

/**
 * True iff `err` is undici's dead-keep-alive-socket failure: fetch
 * rejects with a `TypeError: fetch failed` whose `cause` chain carries
 * `code: 'UND_ERR_SOCKET'` / message `'other side closed'`. This fires
 * when the server closed an idle pooled connection just as the next
 * request went out on it — the request never reached the handler, so
 * one resend is safe. Anything else (HTTP errors, JSON-RPC errors,
 * DNS/refused) is NOT retriable here.
 */
function isDeadSocketError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 5; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === 'UND_ERR_SOCKET') return true;
    if (typeof e.message === 'string' && e.message.includes('other side closed')) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

/**
 * Minimal MCP JSON-RPC over Streamable-HTTP. Posts to `${gguiUrl}${mcpPath}`
 * (default `/mcp`) with a bearer (default `'dev'`); parses either a plain JSON
 * body or the first SSE `data:` frame.
 *
 * Dead-socket resilience: ONE retry (short backoff) when undici reports
 * `UND_ERR_SOCKET` / `'other side closed'` — the keep-alive-reuse race
 * where the request died on the wire before the server processed it
 * (observed flaking the scaffold-render sub-tier-B specs against
 * long-lived `ggui serve` processes). Safe for the calls this driver
 * serves: `ggui_handshake` re-issues a fresh handshakeId, and a
 * `ggui_render` whose request never left the socket was not consumed
 * server-side. The retry does NOT fire on HTTP-level or JSON-RPC-level
 * errors — those mean the server DID process something, and resending
 * could double-consume a handshake.
 */
export async function mcpCall(
  gguiUrl: string,
  method: string,
  params: unknown,
  opts: McpTransportOpts = {},
): Promise<McpEnvelope> {
  const bearer = opts.bearer ?? DEV_BEARER;
  const mcpPath = opts.mcpPath ?? '/mcp';
  const attempt = async (): Promise<McpEnvelope> => {
    const res = await fetch(`${gguiUrl}${mcpPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: `turn-${Date.now()}`, method, params }),
    });
    if (!res.ok) throw new Error(`MCP ${method} → HTTP ${res.status}: ${await res.text()}`);
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct.includes('text/event-stream')) {
      const body = await res.text();
      const data = body
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'));
      if (!data) throw new Error(`MCP ${method} SSE response had no data frame: ${body}`);
      return JSON.parse(data.slice(5).trim()) as McpEnvelope;
    }
    return (await res.json()) as McpEnvelope;
  };
  try {
    return await attempt();
  } catch (err) {
    if (!isDeadSocketError(err)) throw err;
    // Single retry after a short backoff — a fresh connection is
    // established for the resend (the dead pooled socket is gone).
    await new Promise((resolve) => setTimeout(resolve, 250));
    return attempt();
  }
}

/**
 * Drive ONE handshake → render turn against a scaffolded app's ggui server.
 *
 * `forceCreate` forces a cold generation on the handshake (turn-1). `intent` +
 * `contract` (+ optional request-time `variance`, threaded onto
 * `blueprintDraft.variance`) shape the handshake proposal.
 *
 * The render commit is the `override?` axis:
 *   - ACCEPT (reuse the proposal as-is) = OMIT `override` (the default; the
 *     point-read reuses the proposed blueprint).
 *   - `override.contract` = STRICT cold-gen from that contract (never hits).
 *
 * `props` is REQUIRED on the render input; the contracts here declare only
 * optional props, so we pass `props: {}`.
 *
 * Returns the parsed render output + the handshake suggestion + wall-clock ms.
 *
 * `transport` (optional) overrides the bearer + MCP path — see
 * {@link McpTransportOpts}. The local scaffold-render callers omit it (default
 * `Bearer dev` → `/mcp`); the cross-deployment persistence capstone passes
 * `{ bearer: <app key>, mcpPath: '' }` to drive the deployed cloud pod's
 * per-app endpoint.
 */
export async function renderOnce(
  gguiUrl: string,
  opts: {
    intent: string;
    contract: unknown;
    variance?: Variance;
    forceCreate: boolean;
    override?: RenderOverride;
  },
  transport: McpTransportOpts = {},
): Promise<GguiSessionOnceResult> {
  const hs = await mcpCall(
    gguiUrl,
    'tools/call',
    {
      name: 'ggui_handshake',
      arguments: {
        intent: opts.intent,
        blueprintDraft: {
          contract: opts.contract,
          ...(opts.variance !== undefined ? { variance: opts.variance } : {}),
        },
        ...(opts.forceCreate ? { forceCreate: true } : {}),
      },
    },
    transport,
  );
  if (hs.error) throw new Error(`ggui_handshake RPC error: ${hs.error.message}`);
  const handshake = (hs.result as HandshakeResult | undefined)?.structuredContent;
  const handshakeId = handshake?.handshakeId;
  if (!handshakeId) {
    throw new Error(`ggui_handshake returned no handshakeId: ${JSON.stringify(hs.result)}`);
  }

  const t0 = Date.now();
  const env = await mcpCall(
    gguiUrl,
    'tools/call',
    {
      name: 'ggui_render',
      arguments: {
        handshakeId,
        props: {},
        ...(opts.override !== undefined ? { override: opts.override } : {}),
      },
    },
    transport,
  );
  const ms = Date.now() - t0;
  if (env.error) throw new Error(`ggui_render RPC error: ${env.error.message}`);
  const call = env.result as RenderCallResult | undefined;
  if (!call || call.isError) throw new Error(`ggui_render failed: ${JSON.stringify(env.result)}`);
  const render = call.structuredContent;
  if (!render) {
    throw new Error(`ggui_render returned no structuredContent: ${JSON.stringify(env.result)}`);
  }
  return { ...render, ms, suggestion: handshake?.suggestion };
}
