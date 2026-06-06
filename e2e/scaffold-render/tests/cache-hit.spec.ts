/**
 * Sub-tier B — cache-hit scenario. Talks DIRECTLY to the scaffolded app's ggui
 * MCP server (no browser) and proves cross-render blueprint reuse via the
 * RENDER OUTPUT.
 *
 * PRIMARY observable (D1): blueprint IDENTITY equality. Turn-1 is a real cold
 * generation (forceCreate) that mints a durable `blueprintId`; turn-2 ACCEPTS
 * the handshake proposal as-is (the render `override?` is OMITTED) and REUSES
 * that blueprint via the deterministic point-read — proven on the wire by
 * `render2.cache.hit === true` together with `render2.blueprintId ===
 * render1.blueprintId`. Equality of the stable UUID across two independent
 * renders is the load-bearing proof of reuse; the `cache` marker
 * (`cachedBlueprintId`, `llmCallsAvoided`) and the matching
 * `contractHash`/`variantKey` say WHY the reuse fired. Latency stays a SECONDARY
 * soft signal (turn-2 still fast). We do NOT assert on `action` — `action`
 * tracks render-ROW reuse, orthogonal to blueprint reuse (D1).
 *
 * Post-Phase-2D the render-side semantic matcher is DELETED; reuse fires ONLY on
 * an ACCEPT (omitted `override`) whose handshake decision was `origin:'cache'`
 * (an indexed point-read, not the old override-path matcher). Turn-2 therefore
 * accepts; an `override.contract` would STRICT cold-generate by definition and
 * never hit.
 *
 * Five scenarios:
 *   1. IDENTICAL contract → turn-2 hits the exact-key index, then accept reuses.
 *   2. SIMILAR-but-not-identical contract → the exact-key index misses, so the
 *      handshake exercises the relaxed semantic path: it PROPOSES turn-1's
 *      blueprint (`origin:'cache'`, with a `COVERAGE_GAP` finding because the
 *      surface differs), and accept reuses it (same `blueprintId`).
 *   V1. DIFFERENTIATION → same contract, two DIFFERENT variances mint two
 *       DIFFERENT blueprints (no false reuse across the variant axis).
 *   V2. VARIANCE-AWARE EXACT REUSE → same contract + same variance exact-key
 *       hits and reuses.
 *   V3. AGENT DISPOSES ACROSS VARIANCE → same contract, a NEW variance whose
 *       exact key misses; the relaxed semantic path proposes the prior
 *       (different-variance) blueprint with a `VARIANCE_GAP` finding, and accept
 *       reuses it — the agent disposing across the variance gap.
 *
 * Auth: the scaffolded ggui runs `ggui serve --mcp-only --dev-allow-all`, which
 * accepts ANY non-empty bearer as `builder` — no pairing/handshake-token needed.
 *
 * LIVE regression gate: cross-render blueprint reuse is wired on this base. If
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

// ── Regression-gate fixture: mechanically-quirky Gemini-style contract ───────
// Quirks that FAIL a raw `dataContractSchema.safeParse` but are fixed by
// `normalizeDraft` before the match gate:
//   1. Stray `propsSpec`-level `required` array (strict schema rejects it as
//      CTR_SHAPE_UNRECOGNIZED_KEYS).
//   2. Uppercase JSON-Schema type `"STRING"` (protocol only accepts lowercase).
//   3. Pipe-union nullable `"NUMBER|null"` (protocol expects a single string).
// After normalization the contract is a clean, matchable oil-pressure gauge —
// niche enough that turn-1 is a genuine cold gen, so turn-2's hit is
// attributable to turn-1's blueprint (not a shipped default).
const QUIRKY_INTENT = 'Render an oil-pressure gauge for pump station "PS-4"';
const QUIRKY_CONTRACT = {
  propsSpec: {
    description: 'oil pressure gauge',
    required: ['stationLabel'], // stray propsSpec-level `required` — CTR_SHAPE_UNRECOGNIZED_KEYS
    properties: {
      stationLabel: { schema: { type: 'STRING' }, required: false }, // uppercase type
      pressurePsi: { schema: { type: 'NUMBER|null' }, required: false }, // pipe-union nullable
    },
  },
} as const;

// ── Variance-axis fixtures (scenarios V1–V3) ─────────────────────────────────
// Two request-time variances along the persona axis. The reuse identity is
// (contractHash, variantKey) — a different variance derives a different
// variantKey, so the SAME contract under two variances mints two blueprints.
const V_MIN: Variance = { persona: 'minimalist' };
const V_DENSE: Variance = { persona: 'data-dense' };

// Each variance scenario uses a DISTINCT niche contract (unique prop names →
// distinct contractHash) so the scenarios are fully order-independent: no two
// share a contract, so no cross-scenario variantKey collision can let one
// scenario's V_DENSE exact-key-hit another's registration (which would break the
// VARIANCE_GAP / disposes assertions). Each pairs with its own niche intent so
// the contractKey/embedding stay coherent (turn-1 is a genuine cold gen).
const INTENT_V1 = 'Render a battery-health gauge for a delivery drone labelled "Falcon-3"';
const CONTRACT_V1 = {
  propsSpec: {
    description: 'battery gauge',
    properties: {
      droneLabel: { schema: { type: 'string' }, required: false },
      chargePct: { schema: { type: 'number' }, required: false },
    },
  },
} as const;

const INTENT_V2 = 'Render a water-tank level indicator for cistern "Tank-B"';
const CONTRACT_V2 = {
  propsSpec: {
    description: 'tank level',
    properties: {
      tankLabel: { schema: { type: 'string' }, required: false },
      levelPct: { schema: { type: 'number' }, required: false },
    },
  },
} as const;

const INTENT_V3 = 'Render a CPU-temperature dial for server rack "R-12"';
const CONTRACT_V3 = {
  propsSpec: {
    description: 'cpu temp',
    properties: {
      rackLabel: { schema: { type: 'string' }, required: false },
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
interface GguiSessionResult {
  isError?: boolean;
  sessionId?: string;
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
  structuredContent?: GguiSessionResult;
}

/** The parsed render output, the handshake suggestion, and the wall-clock ms. */
interface GguiSessionOnceResult extends GguiSessionResult {
  ms: number;
  suggestion?: HandshakeSuggestion;
}

/** Local mirror of the protocol BlueprintVariance (kept dependency-free). */
interface Variance {
  persona?: string;
  aesthetic?: string;
  context?: Record<string, unknown>;
  seedPrompt?: string;
}
/** Local mirror of the ggui_render `override?` input. */
interface RenderOverride {
  contract?: unknown;
  variance?: Variance;
}

/**
 * Handshake → render once. `forceCreate` forces a cold generation on the
 * handshake (turn-1). `intent` + `contract` (+ optional request-time `variance`,
 * threaded onto `blueprintDraft.variance`) shape the handshake proposal.
 *
 * The render commit is the `override?` axis:
 *   - ACCEPT (reuse the proposal as-is) = OMIT `override` (the default; the
 *     point-read reuses the proposed blueprint).
 *   - `override.contract` = STRICT cold-gen from that contract (never hits).
 *   - `override.variance` = re-aim persona/aesthetic/context/seedPrompt while
 *     keeping the agreed contract (effective variance = override.variance).
 * `props` is REQUIRED on the render input; all contracts here declare only
 * optional props, so we pass `props: {}`.
 *
 * Returns the parsed render output + the handshake suggestion + wall-clock ms.
 */
async function renderOnce(
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

test.describe('scaffold-render: blueprint cache hit across renders (published app)', () => {
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
    'identical contract: render 1 cold-generates, render 2 accept-reuses the same blueprintId',
    async () => {
      test.setTimeout(1_500_000);
      app = await spawnScaffoldedApp({ sdk: 'claude-agent-sdk' });

      // Turn-1: cold generation (forceCreate). `override.contract` STRICT-gens
      // against the fresh draft — it mints the durable id.
      const render1 = await renderOnce(app.gguiUrl, {
        intent: INTENT,
        contract: CONTRACT,
        forceCreate: true,
        override: { contract: CONTRACT },
      });
      // Turn-2: same contract, no forceCreate → handshake proposes turn-1's
      // blueprint (origin:cache); ACCEPT (omit override) reuses it via the
      // point-read.
      const render2 = await renderOnce(app.gguiUrl, {
        intent: INTENT,
        contract: CONTRACT,
        forceCreate: false,
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
        intent: INTENT,
        contract: CONTRACT,
        forceCreate: true,
        override: { contract: CONTRACT },
      });
      // Turn-2: a SIMILAR (superset) contract. It hashes differently so the
      // exact-key index misses — the handshake must take the relaxed semantic
      // tier, which PROPOSES turn-1's blueprint (origin:cache) with a
      // COVERAGE_GAP finding. ACCEPT (omit override) then reuses it via the
      // point-read.
      const render2 = await renderOnce(app.gguiUrl, {
        intent: INTENT,
        contract: SIMILAR_CONTRACT,
        forceCreate: false,
      });
      const gaps =
        render2.suggestion?.validationFindings?.filter((f) => f.code === 'COVERAGE_GAP') ?? [];
      // eslint-disable-next-line no-console -- relaxed-path signal in the CI log.
      console.log(
        `[cache-hit:similar] turn-1 bp=${render1.blueprintId} | ` +
          `turn-2 origin=${render2.suggestion?.origin} hit=${render2.cache?.hit} ` +
          `bp=${render2.blueprintId} coverageGaps=${gaps.length}`,
      );

      // Dump the scaffolded app's captured stdout/stderr so the booted
      // `ggui serve`'s diagnostic lines reach the run log — the embedding
      // boot line (`[ggui:embedding] …`, real-bge vs mock fallback) and
      // the per-lookup cache trace (`[ggui:cache-trace] …`, decision +
      // reason: no-match / low-cosine / no-llm / judge-declined). These
      // are what reveal WHY this relaxed-semantic match did or didn't
      // propose from cache (origin assertion below).
      // eslint-disable-next-line no-console -- diagnostic dump scoped to this scenario.
      console.log(`[cache-hit:similar] scaffolded app output:\n${app.stdout()}`);

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

  // ── Variance-axis scenarios (V1–V3) ─────────────────────────────────────────
  // All three reuse the SAME `app` and each uses a DISTINCT niche contract, so
  // they are fully order-independent — no cross-scenario variantKey collision.

  test(
    'variance V1 — differentiation: same contract, two variances mint two blueprints',
    async () => {
      test.setTimeout(1_500_000);
      app = app ?? (await spawnScaffoldedApp({ sdk: 'claude-agent-sdk' }));

      // Turn-1: ESTABLISH the V_MIN blueprint via `override.contract` — a STRICT
      // cold-gen that bypasses the matcher, so it deterministically registers under
      // (blueprintKey(CONTRACT_V1), variantKey(V_MIN)). A bare accept would NOT do
      // this: the relaxed semantic matcher reuses a prior gauge blueprint under its
      // DEFAULT variance (all these gauge contracts are embedding-similar, cosine
      // ≈0.75-0.94), DROPPING V_MIN — proven by an earlier run where every turn-1
      // collapsed onto the soil-moisture blueprint at variantKey({}). Pinning via
      // override.contract+variance is what actually exercises the variant axis.
      const render1 = await renderOnce(app.gguiUrl, {
        intent: INTENT_V1,
        contract: CONTRACT_V1,
        variance: V_MIN,
        forceCreate: true,
        override: { contract: CONTRACT_V1, variance: V_MIN },
      });
      // Turn-2: same contract under V_DENSE. Pin BOTH via override so the
      // (contractHash, variantKey) identity is fully controlled (no reliance on the
      // cross-gauge semantic matcher): STRICT cold-gen → registers under
      // (blueprintKey(CONTRACT_V1), variantKey(V_DENSE)) — same contractHash as
      // turn-1, different variantKey ⇒ a distinct blueprint.
      const render2 = await renderOnce(app.gguiUrl, {
        intent: INTENT_V1,
        contract: CONTRACT_V1,
        variance: V_DENSE,
        forceCreate: false,
        override: { contract: CONTRACT_V1, variance: V_DENSE },
      });
      // eslint-disable-next-line no-console -- variance differentiation signal.
      console.log(
        `[variance:V1] turn-1 bp=${render1.blueprintId} vk=${render1.variantKey} ` +
          `hash=${render1.contractHash} origin=${render1.suggestion?.origin} | ` +
          `turn-2 bp=${render2.blueprintId} vk=${render2.variantKey} ` +
          `hash=${render2.contractHash} hit=${render2.cache?.hit} ` +
          `gaps=${render2.suggestion?.validationFindings?.length ?? 0}`,
      );

      // Both renders carry the durable identity fields.
      expect(render1.blueprintId, 'V1 turn-1 should carry a blueprintId').toBeTruthy();
      expect(render2.blueprintId, 'V1 turn-2 should carry a blueprintId').toBeTruthy();
      expect(render1.variantKey, 'V1 turn-1 should carry a variantKey').toBeTruthy();
      expect(render2.variantKey, 'V1 turn-2 should carry a variantKey').toBeTruthy();
      expect(render1.contractHash, 'V1 turn-1 should carry a contractHash').toBeTruthy();
      expect(render2.contractHash, 'V1 turn-2 should carry a contractHash').toBeTruthy();

      // DIFFERENTIATION: different variance → different blueprint + variantKey…
      expect(
        render2.blueprintId,
        'V1: a different variance must mint a DIFFERENT blueprint (no false reuse)',
      ).not.toBe(render1.blueprintId);
      expect(
        render2.variantKey,
        'V1: a different variance must derive a DIFFERENT variantKey',
      ).not.toBe(render1.variantKey);
      // …but the contract is identical, so the contractHash is the SAME (only the
      // variant axis differs).
      expect(
        render2.contractHash,
        'V1: same contract → same contractHash (only the variant differs)',
      ).toBe(render1.contractHash);
    },
  );

  test(
    'variance V2 — variance-aware exact reuse: same contract + same variance hits',
    async () => {
      test.setTimeout(1_500_000);
      app = app ?? (await spawnScaffoldedApp({ sdk: 'claude-agent-sdk' }));

      // Turn-1: ESTABLISH the V_MIN blueprint via `override.contract` (STRICT
      // cold-gen, bypasses the cross-gauge matcher) → deterministically registers
      // under (blueprintKey(CONTRACT_V2), variantKey(V_MIN)). This is what makes
      // turn-2's exact-key hit below a REAL variance-aware reuse (not a collapse
      // onto a prior default-variant gauge blueprint).
      const render1 = await renderOnce(app.gguiUrl, {
        intent: INTENT_V2,
        contract: CONTRACT_V2,
        variance: V_MIN,
        forceCreate: true,
        override: { contract: CONTRACT_V2, variance: V_MIN },
      });
      // Turn-2: same contract + same variance, no forceCreate → handshake
      // exact-key (contractKey, variantKey(V_MIN)) HITS → origin:cache → ACCEPT
      // → point-read HITS → reuse.
      const render2 = await renderOnce(app.gguiUrl, {
        intent: INTENT_V2,
        contract: CONTRACT_V2,
        variance: V_MIN,
        forceCreate: false,
      });
      // eslint-disable-next-line no-console -- variance exact-reuse signal.
      console.log(
        `[variance:V2] turn-1 bp=${render1.blueprintId} vk=${render1.variantKey} | ` +
          `turn-2 bp=${render2.blueprintId} vk=${render2.variantKey} ` +
          `origin=${render2.suggestion?.origin} hit=${render2.cache?.hit} ` +
          `gaps=${render2.suggestion?.validationFindings?.length ?? 0}`,
      );

      // EXACT REUSE: same contract + same variance reuses the same blueprint.
      expect(render2.cache?.hit, 'V2 turn-2 should be a cache hit').toBe(true);
      expect(
        render2.blueprintId,
        'V2: same contract + same variance must reuse the same blueprintId',
      ).toBe(render1.blueprintId);
      expect(
        render2.variantKey,
        'V2: same variance must reuse the same variantKey',
      ).toBe(render1.variantKey);
    },
  );

  test(
    'variance V3 — agent disposes across variance: relaxed path reuses despite the gap',
    async () => {
      test.setTimeout(1_500_000);
      app = app ?? (await spawnScaffoldedApp({ sdk: 'claude-agent-sdk' }));

      // Turn-1: ESTABLISH the V_MIN blueprint via `override.contract` (STRICT
      // cold-gen, bypasses the cross-gauge matcher) → deterministically registers
      // under (blueprintKey(CONTRACT_V3), variantKey(V_MIN)). Turn-2's V_DENSE
      // exact-key then genuinely MISSES (a different variantKey), forcing the
      // relaxed semantic path + VARIANCE_GAP — the disposes path this scenario tests.
      const render1 = await renderOnce(app.gguiUrl, {
        intent: INTENT_V3,
        contract: CONTRACT_V3,
        variance: V_MIN,
        forceCreate: true,
        override: { contract: CONTRACT_V3, variance: V_MIN },
      });
      // RELIABILITY (the origin:cache + VARIANCE_GAP assertions ride on the live
      // rerank judge): playwright.config.ts sets `retries: 1`, absorbing transient
      // judge flakiness. More fundamentally, both turns share CONTRACT_V3 — only
      // the variance differs — and the blueprint embedding is computed over the
      // contract (variance-orthogonal), so the V_DENSE relaxed search finds turn-1's
      // V_MIN blueprint at cosine ≈ 1.0 and the similarity-only judge proposes it
      // with high confidence → origin:cache + VARIANCE_GAP fire deterministically.
      //
      // Turn-2: same contract under V_DENSE, ACCEPT (omit override). The
      // exact-key (variantKey(V_DENSE)) MISSES → relaxed semantic path finds
      // turn-1's V_MIN blueprint (identical contract → high embedding similarity)
      // → PROPOSES it (origin:cache) with a VARIANCE_GAP finding (request V_DENSE
      // vs proposed V_MIN). ACCEPT → effective variance = the proposal's V_MIN →
      // point-read (variantKey(V_MIN)) HITS → reuse the minimalist variant for
      // the dense request (the agent-disposes path).
      const render2 = await renderOnce(app.gguiUrl, {
        intent: INTENT_V3,
        contract: CONTRACT_V3,
        variance: V_DENSE,
        forceCreate: false,
      });
      const varianceGaps =
        render2.suggestion?.validationFindings?.filter((f) => f.code === 'VARIANCE_GAP') ?? [];
      // eslint-disable-next-line no-console -- agent-disposes-across-variance signal.
      console.log(
        `[variance:V3] turn-1 bp=${render1.blueprintId} vk=${render1.variantKey} | ` +
          `turn-2 bp=${render2.blueprintId} vk=${render2.variantKey} ` +
          `origin=${render2.suggestion?.origin} hit=${render2.cache?.hit} ` +
          `varianceGaps=${varianceGaps.length}`,
      );
      // Dump the scaffolded app's captured stdout so the `[ggui:cache-trace] …`
      // lines reveal the semantic proposal that bridged the variance gap.
      // eslint-disable-next-line no-console -- diagnostic dump scoped to this scenario.
      console.log(`[variance:V3] scaffolded app output:\n${app.stdout()}`);

      // The handshake proposed the prior (different-variance) blueprint and
      // surfaced the variance difference as a VARIANCE_GAP finding.
      expect(
        varianceGaps.length,
        'V3: a cross-variance reuse should carry at least one VARIANCE_GAP finding',
      ).toBeGreaterThanOrEqual(1);
      expect(
        render2.suggestion?.origin,
        'V3: the prior variant should be proposed from cache (relaxed semantic path)',
      ).toBe('cache');

      // ACCEPT reuses turn-1's V_MIN blueprint across the variance gap (D1).
      expect(render2.cache?.hit, 'V3 turn-2 should be a cache hit').toBe(true);
      expect(
        render2.blueprintId,
        'V3: accept across the variance gap must reuse the V_MIN blueprintId',
      ).toBe(render1.blueprintId);
    },
  );

  test(
    'mechanically-quirky contract (uppercase types / pipe-union / stray required) → normalized, then reused (regression: 4c20c984a)',
    async () => {
      // Regression gate for commit 4c20c984a: `decide-handshake` now falls back
      // to a normalized parse before the blueprint-match gate. Before the fix,
      // any draft that failed a RAW `dataContractSchema.safeParse` was routed
      // straight to cold-gen, so a Gemini-style quirky draft (which has all three
      // malformations above) cold-genned EVERY turn and NEVER reused. After the
      // fix, `normalizeDraft` cleans the draft first; the result is a valid,
      // matchable contract → turn-2 hits the exact-key index and reuses.
      //
      // QUIRKY_CONTRACT fails raw parse (3 issues: uppercase `STRING`, pipe-union
      // `NUMBER|null`, stray `propsSpec.required`). After `normalizeDraft` it is
      // schema-valid and lint-clean with a stable `contractHash`. Turn-2 therefore
      // MUST reuse turn-1's blueprint — otherwise the pre-fix cold-gen regression
      // is back.
      test.setTimeout(1_500_000);
      app = app ?? (await spawnScaffoldedApp({ sdk: 'claude-agent-sdk' }));

      // Turn-1: cold generation (forceCreate), ACCEPT the handshake proposal
      // (OMIT override). The quirky draft can't go through `override.contract` —
      // that path is STRICT (validateContract gate) and would THROW
      // `override_contract_invalid` on the uppercase types / pipe-union / stray
      // `propsSpec.required`. Instead the handshake's forgiving tier runs
      // `ensureConformingContract(quirky)`, whose deterministic normalize tier
      // yields the conforming contract = `normalizeDraft(quirky)`; accepting
      // renders + registers it under `blueprintKey(normalizeDraft(quirky))` —
      // exactly the key turn-2's accept looks up via the normalize-before-match
      // fix. Mints the durable blueprintId we assert on in turn-2.
      const render1 = await renderOnce(app.gguiUrl, {
        intent: QUIRKY_INTENT,
        contract: QUIRKY_CONTRACT,
        forceCreate: true,
      });
      // Turn-2: same quirky contract, no forceCreate → normalizeDraft produces
      // the same clean form → exact-key index HITS → origin:cache → ACCEPT (omit
      // override) → point-read HITS → reuse.
      const render2 = await renderOnce(app.gguiUrl, {
        intent: QUIRKY_INTENT,
        contract: QUIRKY_CONTRACT,
        forceCreate: false,
      });
      // eslint-disable-next-line no-console -- quirky-contract reuse signal in the CI log.
      console.log(
        `[cache-hit:quirky] turn-1 bp=${render1.blueprintId} ms=${render1.ms} | ` +
          `turn-2 bp=${render2.blueprintId} hit=${render2.cache?.hit} ` +
          `cachedBp=${render2.cache?.cachedBlueprintId} avoided=${render2.cache?.llmCallsAvoided} ms=${render2.ms}`,
      );

      // PRIMARY proof (D1): turn-2 reused turn-1's blueprint. If the pre-fix
      // cold-gen regression is back, turn-2 mints a new blueprintId and fails
      // here.
      expect(render2.cache?.hit, 'turn-2 should be a cache hit (quirky contract normalized then reused)').toBe(true);
      expect(render1.blueprintId, 'turn-1 should carry a durable blueprintId').toBeTruthy();
      expect(
        render2.blueprintId,
        'turn-2 blueprintId should EQUAL turn-1 — equality proves normalization ran before the match gate',
      ).toBe(render1.blueprintId);
      expect(
        render2.cache?.cachedBlueprintId,
        'the cache marker should name turn-1 as the reused blueprint',
      ).toBe(render1.blueprintId);
      expect(
        render2.cache?.llmCallsAvoided ?? 0,
        'turn-2 cache hit should report at least one generation call avoided',
      ).toBeGreaterThanOrEqual(1);

      // SECONDARY signal: turn-2 stays fast (no LLM fallthrough).
      expect
        .soft(render2.ms, `turn-2 ${render2.ms}ms — cache hit should be < 10s`)
        .toBeLessThan(10_000);
    },
  );
});
