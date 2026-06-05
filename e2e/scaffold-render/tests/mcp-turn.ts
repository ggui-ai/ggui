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
 * Minimal MCP JSON-RPC over Streamable-HTTP. Posts to `${gguiUrl}/mcp` with a
 * dev bearer; parses either a plain JSON body or the first SSE `data:` frame.
 */
export async function mcpCall(
  gguiUrl: string,
  method: string,
  params: unknown,
): Promise<McpEnvelope> {
  const res = await fetch(`${gguiUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${DEV_BEARER}`,
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
): Promise<GguiSessionOnceResult> {
  const hs = await mcpCall(gguiUrl, 'tools/call', {
    name: 'ggui_handshake',
    arguments: {
      intent: opts.intent,
      blueprintDraft: {
        contract: opts.contract,
        ...(opts.variance !== undefined ? { variance: opts.variance } : {}),
      },
      ...(opts.forceCreate ? { forceCreate: true } : {}),
    },
  });
  if (hs.error) throw new Error(`ggui_handshake RPC error: ${hs.error.message}`);
  const handshake = (hs.result as HandshakeResult | undefined)?.structuredContent;
  const handshakeId = handshake?.handshakeId;
  if (!handshakeId) {
    throw new Error(`ggui_handshake returned no handshakeId: ${JSON.stringify(hs.result)}`);
  }

  const t0 = Date.now();
  const env = await mcpCall(gguiUrl, 'tools/call', {
    name: 'ggui_render',
    arguments: {
      handshakeId,
      props: {},
      ...(opts.override !== undefined ? { override: opts.override } : {}),
    },
  });
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
