/**
 * Scenario 16 — blueprint cache admin path: list → invalidate → cold-gen again.
 *
 * Exercises the operator-facing surfaces under
 * `/ggui/console/blueprints/{cached,cached/:id,cached/clear}` end-to-end
 * against a live server that just did a real cold-gen.
 *
 * Flow:
 *   1. Render with a deterministic override-contract → cold-gen runs,
 *      registry writes a `template:${contractKey}` row.
 *   2. GET `/ggui/console/blueprints/cached` → row appears with the
 *      new-shape fields (`contractKey`, `kind`, `cachedIntent`,
 *      `cachedAt`).
 *   3. Second render with the SAME contract → exact-key hit (codeHash
 *      matches, latency under cold-gen budget).
 *   4. DELETE the row via `/ggui/console/blueprints/cached/:id`.
 *   5. GET again → list is empty (defensive: filter-by-`contractKey`
 *      since other concurrent test scenarios may have left rows in
 *      the same scope, even though parallel suite runs are gated).
 *   6. Third render with the same contract → cold-gen fires again
 *      (different renderId guaranteed). The structural proof is
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
 * Gated on `ANTHROPIC_API_KEY` — needs at least one real cold-gen to
 * have a row to invalidate.
 */
import { describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import {
  CACHE_ADMIN_CONTRACT,
  CACHE_ADMIN_INTENT,
} from '../fixtures/cache-contracts.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

interface RenderOut {
  renderId: string;
  url?: string;
}

interface BootstrapJson {
  codeUrl?: string;
  codeHash?: string;
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

function bootstrapUrlFromRenderUrl(renderUrl: string | undefined): string {
  if (typeof renderUrl !== 'string') {
    throw new Error(`render output missing url: ${String(renderUrl)}`);
  }
  // Render URL shape: `<base>/r/<shortCode>?sig=...&exp=...`. Rewrite the
  // host to the local dev port, preserve the signed query. R4 retired
  // `/api/bootstrap/:shortCode`; content-negotiated `/r/:shortCode`
  // covers the same surface.
  const parsed = new URL(renderUrl);
  const codeMatch = /^\/r\/([^/]+)$/.exec(parsed.pathname);
  if (!codeMatch || typeof codeMatch[1] !== 'string') {
    throw new Error(`url has no /r/<shortCode>: ${renderUrl}`);
  }
  return `http://localhost:${GGUI_PORT}/r/${codeMatch[1]}${parsed.search}`;
}

async function fetchBootstrap(renderUrl: string | undefined): Promise<BootstrapJson> {
  const resp = await fetch(bootstrapUrlFromRenderUrl(renderUrl), {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(
      `bootstrap fetch ${resp.status}: ${await resp.text().catch(() => '<no body>')}`,
    );
  }
  // R4: slice envelope — flatten the render slice into the legacy
  // shape the test consumes.
  const envelope = (await resp.json()) as Record<string, unknown>;
  const renderSlice =
    (envelope['ai.ggui/render'] as Record<string, unknown> | undefined) ??
    {};
  return {
    codeUrl: typeof renderSlice['codeUrl'] === 'string' ? renderSlice['codeUrl'] : undefined,
    codeHash: typeof renderSlice['codeHash'] === 'string' ? renderSlice['codeHash'] : undefined,
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

async function renderWithContract(): Promise<{
  out: RenderOut;
  bootstrap: BootstrapJson;
  latencyMs: number;
}> {
  const handshake = unwrapStructured<{ handshakeId: string }>(
    await callTool(MCP_URL, 'ggui_handshake', {
      intent: CACHE_ADMIN_INTENT,
      blueprintDraft: { contract: CACHE_ADMIN_CONTRACT },
    }),
  );
  const start = Date.now();
  const out = unwrapStructured<RenderOut>(
    await callTool(MCP_URL, 'ggui_render', {
      handshakeId: handshake.handshakeId,
      decision: {
        kind: 'override',
        blueprintDraft: { contract: CACHE_ADMIN_CONTRACT },
      },
      props: { message: 'hello' },
    }),
  );
  const latencyMs = Date.now() - start;
  const bootstrap = await fetchBootstrap(out.url);
  return { out, bootstrap, latencyMs };
}

describe.skipIf(!HAS_KEY)(
  'Scenario 16 — cache admin: list + invalidate + re-register',
  () => {
    test(
      'cached render lands a registry row; DELETE clears it; next render re-registers',
      async () => {
        // ── 1. cold-gen primes the registry ─────────────────────────
        const cold = await renderWithContract();
        expect(cold.out.renderId).toBeTruthy();
        expect(typeof cold.bootstrap.codeHash).toBe('string');

        // ── 2. /cached lists the new row in the new-shape projection
        const listAfterPrime = await fetchCachedList();
        const ourEntry = listAfterPrime.entries.find(
          (e) => e.cachedIntent === CACHE_ADMIN_INTENT,
        );
        expect(ourEntry).toBeDefined();
        expect(ourEntry!.kind).toBe('template');
        expect(typeof ourEntry!.contractKey).toBe('string');
        expect(ourEntry!.contractKey!.length).toBeGreaterThan(0);
        // Synthetic id = `${kind}:${contractKey}`.
        expect(ourEntry!.id).toBe(`template:${ourEntry!.contractKey}`);

        // ── 3. second render with same contract = exact-key hit ────
        const warm = await renderWithContract();
        expect(warm.bootstrap.codeHash).toBe(cold.bootstrap.codeHash);
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
        const reCold = await renderWithContract();
        expect(reCold.out.renderId).toBeTruthy();

        const listAfterReprime = await fetchCachedList();
        const repopulated = listAfterReprime.entries.find(
          (e) => e.id === ourEntry!.id,
        );
        expect(repopulated).toBeDefined();
        // The re-registered row lives at the same `(scope, kind,
        // contractKey)` slot — identical id proves the cache key is
        // contract-derived, not render/timestamp/random.
        expect(repopulated!.contractKey).toBe(ourEntry!.contractKey);
        expect(repopulated!.kind).toBe(ourEntry!.kind);
      },
      300_000,
    );
  },
);
