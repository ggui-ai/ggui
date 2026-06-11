/**
 * Scenario 16 — blueprint cache admin path: list → invalidate → cold-gen again.
 *
 * Exercises the operator-facing surfaces under
 * `/ggui/console/blueprints/{cached,cached/:id,cached/clear}` end-to-end
 * against a live server that just did a real cold-gen.
 *
 * Flow:
 *   1. Render with a deterministic override-contract → cold-gen runs,
 *      registry writes a blueprint row at the `(kind: 'template',
 *      contractKey)` slot.
 *   2. GET `/ggui/console/blueprints/cached` → row appears with the
 *      new-shape fields (`contractKey`, `kind`, `cachedIntent`,
 *      `cachedAt`).
 *   3. Second handshake + ACCEPT render (override omitted) with the
 *      SAME contract → exact-key hit (codeHash matches the stored
 *      bytes, latency under cold-gen budget).
 *   4. DELETE the row via `/ggui/console/blueprints/cached/:id`.
 *   5. GET again → list is empty (defensive: filter-by-`contractKey`
 *      since other concurrent test scenarios may have left rows in
 *      the same scope, even though parallel suite runs are gated).
 *   6. Third render with the same contract → cold-gen fires again
 *      (different sessionId guaranteed). The structural proof is
 *      that the registry row reappears at the same contractKey slot
 *      — cache writes only happen at the END of a successful gen
 *      pipeline, so a present row proves the cold path ran.
 *
 * The signal that the admin invalidation worked is **step 5's empty
 * list for the targeted contractKey** plus **step 6's cache write
 * producing the row again**. We do NOT compare cold-2 codeHash vs
 * cold-1: LLM output is not byte-deterministic across separate API
 * round-trips even at temperature 0 (server-side sampling jitter
 * shifts description strings, reorders fields, etc.). Different
 * componentCode → different sha256 → different codeHash. That's
 * expected and not a cache regression.
 *
 * ## Obligation remapping (2026-06-11 retired-surfaces port)
 *
 * The cache semantics under test are UNCHANGED; two reads moved to
 * their live surfaces:
 *
 *   - `codeHash` — this spec used to fetch the content-negotiated
 *     bootstrap JSON from the render's `/r/<shortCode>` URL; both are
 *     retired (R5 removed the `/r/<shortCode>` HTTP surface, and
 *     `ggui_render`'s wire output carries no `url`; zod strips
 *     `codeUrl`/`codeHash` from `structuredContent`). The live surface
 *     is the render response's `_meta["ai.ggui/render"]` slice — the
 *     single `deriveRenderMeta`-fed projection
 *     (docs/principles/mcp-apps-compliance.md) — narrowed at the trust
 *     boundary via the protocol's own `parseMcpAppAiGguiRenderMeta`.
 *   - Row-id pin re-derived empirically: the UUID blueprint-identity
 *     arc replaced the synthetic `${kind}:${contractKey}` row id with
 *     an opaque `bp_<uuid>` key minted once per `(kind, contractKey,
 *     variantKey)` (see blueprint-registry.ts). The contract-derived
 *     identity pin is now the `(kind, contractKey)` SLOT: after
 *     delete + re-prime the row reappears at the same slot with a
 *     FRESH `bp_` id (the delete leaves the index binding dangling;
 *     `registerBlueprint` self-heals by minting anew).
 *   - Warm-leg pin re-derived empirically: `override.contract` is now
 *     STRICT cold-gen on every call (the wire's override = "re-aim,
 *     gen against the literal draft" — it never reuses, and its
 *     re-registration dedups to the existing row without overwriting
 *     stored bytes). The exact-key reuse leg rides the ACCEPT path
 *     (handshake → render with `override` omitted), same as scenarios
 *     17 + 18 — so step 3 accepts instead of overriding.
 *
 * The console admin routes this scenario pins are live, unretired
 * surfaces.
 *
 * Gated on `ANTHROPIC_API_KEY` — needs at least one real cold-gen to
 * have a row to invalidate.
 */
import { describe, expect, test } from 'vitest';
import { parseMcpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  callTool,
  unwrapStructured,
  type JsonRpcResponse,
} from '../fixtures/mcp-client.js';
import {
  CACHE_ADMIN_CONTRACT,
  CACHE_ADMIN_INTENT,
} from '../fixtures/cache-contracts.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

interface RenderOut {
  sessionId: string;
}

interface RenderCodeRef {
  readonly codeUrl?: string;
  readonly codeHash?: string;
}

interface CachedEntry {
  id: string;
  cachedIntent: string;
  cachedAt: string;
  contractKey?: string;
  kind?: string;
  hitCount?: number;
}

interface CachedListResponse {
  entries: readonly CachedEntry[];
  total: number;
}

/**
 * Read `codeUrl` + `codeHash` off the render response's
 * `_meta["ai.ggui/render"]` slice — the live replacement for the
 * retired `/r/<shortCode>` bootstrap fetch. Same helper as scenarios
 * 11 + 17 (spec-local; fixture-worthy once `fixtures/` reopens).
 */
function readRenderCodeRef(resp: JsonRpcResponse): RenderCodeRef {
  const parsed = parseMcpAppAiGguiRenderMeta(resp.result?._meta);
  if (!parsed.ok) {
    throw new Error(
      `render response carries a malformed ai.ggui/render slice: ${JSON.stringify(resp.result?._meta).slice(0, 400)}`,
    );
  }
  if (parsed.meta === undefined) {
    throw new Error(
      `render response missing the ai.ggui/render slice meta: ${JSON.stringify(resp.result?._meta).slice(0, 400)}`,
    );
  }
  return {
    ...(parsed.meta.codeUrl !== undefined ? { codeUrl: parsed.meta.codeUrl } : {}),
    ...(parsed.meta.codeHash !== undefined ? { codeHash: parsed.meta.codeHash } : {}),
  };
}

async function fetchCachedList(): Promise<CachedListResponse> {
  const resp = await fetch(
    `http://localhost:${GGUI_PORT}/ggui/console/blueprints/cached`,
    { headers: { accept: 'application/json' } },
  );
  if (!resp.ok) {
    throw new Error(
      `cached list ${resp.status}: ${await resp.text().catch(() => '<no body>')}`,
    );
  }
  return (await resp.json()) as CachedListResponse;
}

async function deleteCacheEntry(id: string): Promise<void> {
  const resp = await fetch(
    `http://localhost:${GGUI_PORT}/ggui/console/blueprints/cached/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  if (!resp.ok && resp.status !== 204) {
    throw new Error(
      `cached delete ${resp.status}: ${await resp.text().catch(() => '<no body>')}`,
    );
  }
}

/**
 * Handshake + render against the scenario contract.
 *
 *   - `decision: 'override'` — STRICT cold-gen against the literal
 *     draft; registers/refreshes the registry slot. Priming legs.
 *   - `decision: 'accept'` — omit `override`; the render follows the
 *     handshake's effectiveContract and exact-key reuses the stored
 *     bytes when the slot is populated. Warm leg.
 */
async function renderWithContract(decision: 'override' | 'accept'): Promise<{
  out: RenderOut;
  code: RenderCodeRef;
  latencyMs: number;
}> {
  const handshake = unwrapStructured<{ handshakeId: string }>(
    await callTool(MCP_URL, 'ggui_handshake', {
      intent: CACHE_ADMIN_INTENT,
      blueprintDraft: { contract: CACHE_ADMIN_CONTRACT },
    }),
  );
  const start = Date.now();
  const renderResp = await callTool(MCP_URL, 'ggui_render', {
    handshakeId: handshake.handshakeId,
    props: { message: 'hello' },
    ...(decision === 'override'
      ? { override: { contract: CACHE_ADMIN_CONTRACT } }
      : {}),
  });
  const out = unwrapStructured<RenderOut>(renderResp);
  const latencyMs = Date.now() - start;
  return { out, code: readRenderCodeRef(renderResp), latencyMs };
}

describe.skipIf(!HAS_KEY)(
  'Scenario 16 — cache admin: list + invalidate + re-register',
  () => {
    test(
      'cached render lands a registry row; DELETE clears it; next render re-registers',
      async () => {
        // ── 1. cold-gen primes the registry ─────────────────────────
        const cold = await renderWithContract('override');
        expect(cold.out.sessionId).toBeTruthy();
        expect(typeof cold.code.codeHash).toBe('string');

        // ── 2. /cached lists the new row in the new-shape projection
        const listAfterPrime = await fetchCachedList();
        const ourEntry = listAfterPrime.entries.find(
          (e) => e.cachedIntent === CACHE_ADMIN_INTENT,
        );
        expect(ourEntry).toBeDefined();
        expect(ourEntry!.kind).toBe('template');
        expect(typeof ourEntry!.contractKey).toBe('string');
        expect(ourEntry!.contractKey!.length).toBeGreaterThan(0);
        // Row id = the opaque blueprint UUID (`bp_<uuid>`) minted at
        // first registration. The pre-UUID synthetic
        // `${kind}:${contractKey}` id shape is gone — slot identity
        // lives on the (kind, contractKey) columns instead.
        expect(ourEntry!.id).toMatch(/^bp_/);

        // ── 3. second render with same contract = exact-key hit ────
        // ACCEPT path: override is strict-cold-gen by contract, so the
        // reuse leg omits it — the handshake matches the populated slot
        // and render serves the stored bytes.
        const warm = await renderWithContract('accept');
        expect(warm.code.codeHash).toBe(cold.code.codeHash);
        expect(warm.latencyMs).toBeLessThan(5_000);

        // ── 4. DELETE invalidates the row ──────────────────────────
        await deleteCacheEntry(ourEntry!.id);

        const listAfterDelete = await fetchCachedList();
        const stillThere = listAfterDelete.entries.find(
          (e) => e.id === ourEntry!.id,
        );
        expect(stillThere).toBeUndefined();

        // ── 5. third render re-runs cold-gen + re-registers the row
        // We don't gate on latency — Haiku-class cold-gen for a small
        // contract can complete in <3s, which would false-positive a
        // "did cold-gen really run?" timing check. The structural
        // proof is that the registry row reappears: cache writes only
        // happen at the END of a successful gen pipeline, so a present
        // row proves the cold path ran.
        const reCold = await renderWithContract('override');
        expect(reCold.out.sessionId).toBeTruthy();

        const listAfterReprime = await fetchCachedList();
        const repopulated = listAfterReprime.entries.find(
          (e) =>
            e.contractKey === ourEntry!.contractKey &&
            e.kind === ourEntry!.kind,
        );
        expect(repopulated).toBeDefined();
        // The re-registered row lives at the same `(scope, kind,
        // contractKey)` slot — same slot proves the cache key is
        // contract-derived, not render/timestamp/random. The id is a
        // FRESH `bp_<uuid>`: the DELETE left the old index binding
        // dangling, and registerBlueprint's self-heal mints anew —
        // a matching slot with a NEW id is the structural proof the
        // cold path re-ran (a stale read of the deleted row would
        // carry the old id).
        expect(repopulated!.id).toMatch(/^bp_/);
        expect(repopulated!.id).not.toBe(ourEntry!.id);
      },
      300_000,
    );
  },
);
