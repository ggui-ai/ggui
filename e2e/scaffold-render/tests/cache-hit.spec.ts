/**
 * Sub-tier B — cache-hit scenario. Talks DIRECTLY to the scaffolded app's ggui
 * MCP server (no browser) and proves cross-session blueprint reuse via the
 * RENDER OUTPUT.
 *
 * PRIMARY observable (D1): blueprint IDENTITY equality. Turn-1 is a real cold
 * generation (forceCreate) that mints a durable `blueprintId`; turn-2 sends
 * `decision:{kind:'accept'}` and REUSES that blueprint via the deterministic
 * point-read — proven on the wire by `render2.cache.hit === true` together with
 * `render2.blueprintId === render1.blueprintId`. Equality of the stable UUID
 * across two independent renders is the load-bearing proof of reuse; the `cache`
 * marker (`cachedBlueprintId`, `llmCallsAvoided`) and the matching
 * `contractHash`/`variantKey` say WHY the reuse fired. Latency stays a SECONDARY
 * soft signal (turn-2 still fast). We do NOT assert on `action` — `action`
 * tracks render-ROW reuse, orthogonal to blueprint reuse (D1).
 *
 * Post-Phase-2D the render-side semantic matcher is DELETED; reuse fires ONLY on
 * `accept` whose handshake decision was `origin:'cache'` (an indexed point-read,
 * not the old override-path matcher). Turn-2 therefore uses `accept`; an
 * override would cold-generate by definition and never hit.
 *
 * Two scenarios:
 *   1. IDENTICAL contract → turn-2 hits the exact-key index, then accept reuses.
 *   2. SIMILAR-but-not-identical contract → the exact-key index misses, so the
 *      handshake exercises the relaxed semantic path: it PROPOSES turn-1's
 *      blueprint (`origin:'cache'`, with a `COVERAGE_GAP` finding because the
 *      surface differs), and `accept` reuses it (same `blueprintId`).
 *
 * Auth: the scaffolded ggui runs `ggui serve --mcp-only --dev-allow-all`, which
 * accepts ANY non-empty bearer as `builder` — no pairing/handshake-token needed.
 *
 * LIVE regression gate: cross-session blueprint reuse is wired on this base. If
 * a change breaks reuse, turn-2 mints a NEW blueprintId (and latency climbs),
 * failing the identity assertion.
 */
import { test, expect } from '@playwright/test';
import { spawnScaffoldedApp, type ScaffoldAppHandle } from './scaffold-app-harness';

// --dev-allow-all accepts any non-empty bearer as `builder`.
const DEV_BEARER = 'dev';

// A niche contract → no built-in blueprint match → turn-1 is a genuine cold
// generation, and turn-2's hit is attributable to turn-1, not a shipped default.
const INTENT = 'Render a soil-moisture gauge panel for a greenhouse zone labelled "Bed 7"';
const CONTRACT = {
  propsSpec: {
    description: 'gauge',
    properties: {
      zoneLabel: { schema: { type: 'string' }, required: false },
      moisturePct: { schema: { type: 'number' }, required: false },
    },
  },
} as const;

// SIMILAR-but-not-identical: a superset surface (one extra prop). Hashes
// differently from CONTRACT, so the exact-key index misses and the handshake
// must fall to the relaxed semantic tier — which proposes turn-1's blueprint
// with a COVERAGE_GAP finding (the cached contract doesn't cover `tempC`).
const SIMILAR_CONTRACT = {
  propsSpec: {
    description: 'gauge',
    properties: {
      zoneLabel: { schema: { type: 'string' }, required: false },
      moisturePct: { schema: { type: 'number' }, required: false },
      tempC: { schema: { type: 'number' }, required: false },
    },
  },
} as const;

// MCP JSON-RPC envelope. `result` is the CallToolResult — a per-tool shape, so
// Record<string, unknown> is the honest transport-boundary type (the same shape
// the journeys ggui-serve-harness uses); specs narrow it with the named result
// interfaces below.
interface McpEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}
/** Validator finding on the suggestion (only the read fields). */
interface SuggestionFinding {
  code: string;
  severity: string;
  path: string;
  message: string;
}
/** Handshake suggestion (the bits we read for the relaxed-path scenario). */
interface HandshakeSuggestion {
  origin?: string;
  proposedContractSummary?: string;
  validationFindings?: SuggestionFinding[];
}
/** ggui_handshake CallToolResult (the bits we read). */
interface HandshakeResult {
  structuredContent?: { handshakeId?: string; suggestion?: HandshakeSuggestion };
}
/**
 * Reuse-outcome marker on `ggui_render`'s `renderCacheMarkerSchema`. Mirrored
 * locally (rather than imported from `@ggui-ai/protocol`) to keep this Verdaccio
 * sub-tier-B harness dependency-free — same transport-boundary stance as the
 * `Record<string, unknown>` envelope above. Only the read fields are modeled.
 */
interface RenderCacheMarker {
  hit: boolean;
  similarity?: number;
  cachedBlueprintId?: string;
  llmCallsAvoided: number;
  kind?: 'full-template' | 'cold';
}
/**
 * ggui_render CallToolResult (the bits we check). `blueprintId` + `variantKey` +
 * `contractHash` + `cache` are the reuse-visibility fields surfaced on
 * `renderOutputSchema`; `action` rides along for completeness but is NOT
 * asserted on (it tracks render-row reuse, orthogonal to blueprint reuse — D1).
 */
interface RenderResult {
  isError?: boolean;
  renderId?: string;
  action?: string;
  blueprintId?: string;
  variantKey?: string;
  contractHash?: string;
  cache?: RenderCacheMarker;
}

/**
 * Minimal MCP JSON-RPC over Streamable-HTTP. Inlined (rather than importing the
 * journeys harness) so this spec is fully self-contained — it speaks to the
 * scaffolded app's ggui server, not a workspace-spawned one, and pulls in no
 * import-time filesystem-walking helpers.
 */
async function mcpCall(gguiUrl: string, method: string, params: unknown): Promise<McpEnvelope> {
  const res = await fetch(`${gguiUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${DEV_BEARER}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `cache-${Date.now()}`, method, params }),
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

/** ggui_render CallToolResult envelope — the structured fields ride on `structuredContent`. */
interface RenderCallResult {
  isError?: boolean;
  structuredContent?: RenderResult;
}

/** The parsed render output, the handshake suggestion, and the wall-clock ms. */
interface RenderOnceResult extends RenderResult {
  ms: number;
  suggestion?: HandshakeSuggestion;
}

type RenderDecision =
  | { kind: 'accept' }
  | { kind: 'override'; blueprintDraft: { contract: unknown } };

/**
 * Handshake → render once. `forceCreate` forces a cold generation on the
 * handshake (turn-1); `decision` is what the paired render commits (`accept`
 * reuses the proposed contract via the point-read; `override` cold-gens from a
 * fresh draft). Returns the parsed render output + the handshake suggestion +
 * wall-clock ms.
 */
async function renderOnce(
  gguiUrl: string,
  opts: { contract: unknown; forceCreate: boolean; decision: RenderDecision },
): Promise<RenderOnceResult> {
  const hs = await mcpCall(gguiUrl, 'tools/call', {
    name: 'ggui_handshake',
    arguments: {
      intent: INTENT,
      blueprintDraft: { contract: opts.contract },
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
    arguments: { handshakeId, decision: opts.decision },
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

test.describe('scaffold-render: blueprint cache hit across sessions (published app)', () => {
  let app: ScaffoldAppHandle | undefined;

  test.beforeAll(() => {
    test.skip(
      !process.env['ANTHROPIC_API_KEY']?.trim(),
      'set ANTHROPIC_API_KEY — the cold turn-1 is a real LLM generation',
    );
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test(
    'identical contract: session 1 cold-generates, session 2 accept-reuses the same blueprintId',
    async () => {
      test.setTimeout(1_500_000);
      app = await spawnScaffoldedApp({ sdk: 'claude-agent-sdk' });

      // Turn-1: cold generation (forceCreate). Decision is `override` only to
      // commit the cold gen against the fresh draft — it mints the durable id.
      const render1 = await renderOnce(app.gguiUrl, {
        contract: CONTRACT,
        forceCreate: true,
        decision: { kind: 'override', blueprintDraft: { contract: CONTRACT } },
      });
      // Turn-2: same contract, no forceCreate → handshake proposes turn-1's
      // blueprint (origin:cache); `accept` reuses it via the point-read.
      const render2 = await renderOnce(app.gguiUrl, {
        contract: CONTRACT,
        forceCreate: false,
        decision: { kind: 'accept' },
      });
      // eslint-disable-next-line no-console -- reuse + latency signal in the CI log.
      console.log(
        `[cache-hit] turn-1 bp=${render1.blueprintId} ms=${render1.ms} | ` +
          `turn-2 bp=${render2.blueprintId} hit=${render2.cache?.hit} ` +
          `cachedBp=${render2.cache?.cachedBlueprintId} avoided=${render2.cache?.llmCallsAvoided} ms=${render2.ms}`,
      );

      // PRIMARY proof (D1): turn-2 reused turn-1's blueprint.
      expect(render2.cache?.hit, 'turn-2 should be a cache hit').toBe(true);
      expect(render1.blueprintId, 'turn-1 should carry a durable blueprintId').toBeTruthy();
      expect(
        render2.blueprintId,
        'turn-2 blueprintId should EQUAL turn-1 (equality ⟺ reuse — the load-bearing proof)',
      ).toBe(render1.blueprintId);
      expect(
        render2.cache?.cachedBlueprintId,
        'the cache marker should name turn-1 as the reused blueprint',
      ).toBe(render1.blueprintId);
      expect(
        render2.cache?.llmCallsAvoided ?? 0,
        'turn-2 cache hit should report at least one generation call avoided',
      ).toBeGreaterThanOrEqual(1);

      // WHY reuse fired: identical data flow ⟺ identical hash + variant key.
      expect(render1.contractHash, 'turn-1 should carry a contractHash').toBeTruthy();
      expect(
        render2.contractHash,
        'turn-2 contractHash should equal turn-1 (same contract → same hash)',
      ).toBe(render1.contractHash);
      expect(
        render2.variantKey,
        'turn-2 variantKey should equal turn-1 (same variance → same key)',
      ).toBe(render1.variantKey);

      // SECONDARY signal: turn-2 stays fast (no LLM fallthrough). Soft so a slow
      // CI box doesn't mask the primary identity failure mode above.
      expect
        .soft(render2.ms, `turn-2 ${render2.ms}ms — cache hit should be < 10s`)
        .toBeLessThan(10_000);
    },
  );

  test(
    'similar-but-not-identical contract: handshake proposes the prior blueprint, accept reuses it',
    async () => {
      test.setTimeout(1_500_000);
      // Reuse the app booted by the first scenario when present; otherwise boot.
      app = app ?? (await spawnScaffoldedApp({ sdk: 'claude-agent-sdk' }));

      // Turn-1: establish a blueprint with the base contract (cold gen).
      const render1 = await renderOnce(app.gguiUrl, {
        contract: CONTRACT,
        forceCreate: true,
        decision: { kind: 'override', blueprintDraft: { contract: CONTRACT } },
      });
      // Turn-2: a SIMILAR (superset) contract. It hashes differently so the
      // exact-key index misses — the handshake must take the relaxed semantic
      // tier, which PROPOSES turn-1's blueprint (origin:cache) with a
      // COVERAGE_GAP finding. `accept` then reuses it via the point-read.
      const render2 = await renderOnce(app.gguiUrl, {
        contract: SIMILAR_CONTRACT,
        forceCreate: false,
        decision: { kind: 'accept' },
      });
      const gaps =
        render2.suggestion?.validationFindings?.filter((f) => f.code === 'COVERAGE_GAP') ?? [];
      // eslint-disable-next-line no-console -- relaxed-path signal in the CI log.
      console.log(
        `[cache-hit:similar] turn-1 bp=${render1.blueprintId} | ` +
          `turn-2 origin=${render2.suggestion?.origin} hit=${render2.cache?.hit} ` +
          `bp=${render2.blueprintId} coverageGaps=${gaps.length}`,
      );

      // The handshake proposed the prior blueprint despite the surface diff.
      expect(
        render2.suggestion?.origin,
        'similar contract should be proposed from cache (relaxed semantic path)',
      ).toBe('cache');
      // The differing surface surfaces a COVERAGE_GAP so the agent can decide.
      expect(
        gaps.length,
        'a non-covering reuse should carry at least one COVERAGE_GAP finding',
      ).toBeGreaterThanOrEqual(1);

      // accept reuses turn-1's blueprint — same durable id (D1).
      expect(render2.cache?.hit, 'turn-2 should be a cache hit').toBe(true);
      expect(
        render2.blueprintId,
        'turn-2 blueprintId should EQUAL turn-1 (relaxed-path reuse)',
      ).toBe(render1.blueprintId);

      // SECONDARY: still fast (no LLM fallthrough).
      expect
        .soft(render2.ms, `turn-2 ${render2.ms}ms — cache hit should be < 10s`)
        .toBeLessThan(10_000);
    },
  );
});
