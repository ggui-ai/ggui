/**
 * Scenario 17 — cold path then cache: first handshake misses → render
 * primes the registry → second handshake hits cache via the new
 * matchBlueprint fast path.
 *
 * What this proves: the registry-fill loop closes end-to-end through
 * the agent-facing wire. Render registers the cold-gen output via
 * `registerBlueprint` (see `render.ts` blueprint-write path post-gen);
 * the next handshake with the same contract — even with a paraphrased
 * intent — surfaces `origin: 'cache'` + `codeHash`; that handshake's
 * `effectiveContract` carries the matched blueprint's contract; render.
 * accept then exact-key hits and serves the cached bytes.
 *
 * This is the natural agent flow when there's no operator-side
 * `ggui_ops_generate_blueprint` priming. The blueprint arrives in the
 * registry organically — agent A's render primes it, agent B (or agent
 * A on a later turn) reuses it.
 *
 * Flow:
 *   1. `ggui_handshake({intent: COLD_PATH_INTENT_CANONICAL,
 *      blueprintDraft: {contract: COLD_PATH_CONTRACT}})`.
 *      Assert: `suggestion.origin !== 'cache'` (cold — should be
 *      `'agent'` or `'synth'`), `blueprintMeta.codeHash === undefined`.
 *   2. `ggui_render({handshakeId, decision: {kind: 'override',
 *      blueprintDraft: {contract: COLD_PATH_CONTRACT}}})`. Override
 *      forces render to use the LITERAL draft (not the negotiator's
 *      potentially-amended effectiveContract); cold-gen runs and
 *      registers `template:${blueprintKey(COLD_PATH_CONTRACT)}`.
 *      Capture `cold.bootstrap.codeHash`.
 *   3. `ggui_handshake({intent: COLD_PATH_INTENT_PARAPHRASED,
 *      blueprintDraft: {contract: COLD_PATH_CONTRACT}})`.
 *      Assert: `suggestion.origin === 'cache'`,
 *      `blueprintMeta.codeHash` present.
 *   4. `ggui_render({handshakeId, decision: {kind: 'accept'}})`.
 *      Assert: `warm.bootstrap.codeHash === cold.bootstrap.codeHash`
 *      AND warm render latency < 5s.
 *
 * **Why override on step 2, not accept**: the OSS negotiator's synth
 * runs on every cold handshake and may amend the draft (e.g. add a
 * required field). If step 2 went accept-path, `effectiveContract`
 * would be the amended contract, render would register under
 * `blueprintKey(amended)`, and step 3's handshake against the literal
 * draft would key-miss. Override pins the registered contract to the
 * literal draft so step 3's handshake exact-key matches.
 *
 * Gated on `ANTHROPIC_API_KEY` — step 2 cold-gens once.
 */
import { describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import {
  COLD_PATH_CONTRACT,
  COLD_PATH_INTENT_CANONICAL,
  COLD_PATH_INTENT_PARAPHRASED,
} from '../fixtures/cache-contracts.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

interface BlueprintMeta {
  blueprintId: string;
  contractHash: string;
  codeHash?: string;
  generator: string;
}

interface HandshakeSuggestion {
  origin: 'cache' | 'agent' | 'synth';
  rationale: string;
  blueprintMeta: BlueprintMeta;
}

interface HandshakeOut {
  handshakeId: string;
  action: string;
  suggestion: HandshakeSuggestion;
}

interface RenderOut {
  renderId: string;
  url?: string;
}

interface BootstrapJson {
  codeUrl?: string;
  codeHash?: string;
}

function bootstrapUrlFromRenderUrl(renderUrl: string | undefined): string {
  if (typeof renderUrl !== 'string') {
    throw new Error(`push output missing url: ${String(renderUrl)}`);
  }
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

async function handshakeFresh(intent: string): Promise<HandshakeOut> {
  return unwrapStructured<HandshakeOut>(
    await callTool(MCP_URL, 'ggui_handshake', {
      intent,
      blueprintDraft: { contract: COLD_PATH_CONTRACT },
    }),
  );
}

describe.skipIf(!HAS_KEY)(
  'Scenario 17 — cold path then cache via handshake-time match',
  () => {
    test(
      'cold render primes registry; next handshake matches; render.accept reuses',
      async () => {
        // ── 1. Cold handshake — no blueprint in the registry yet ───
        const coldHandshake = await handshakeFresh(COLD_PATH_INTENT_CANONICAL);
        expect(coldHandshake.suggestion.origin).not.toBe('cache');
        expect(coldHandshake.suggestion.blueprintMeta.codeHash).toBeUndefined();

        // ── 2. Cold render (override) — registers under literal draft
        // Override avoids the synth-amended-contract trap; the
        // registry slot id is blueprintKey(COLD_PATH_CONTRACT) so
        // step 3's exact-key probe with the same draft must hit.
        const coldRender = unwrapStructured<RenderOut>(
          await callTool(MCP_URL, 'ggui_render', {
            handshakeId: coldHandshake.handshakeId,
            decision: {
              kind: 'override',
              blueprintDraft: { contract: COLD_PATH_CONTRACT },
            },
          }),
        );
        const coldBootstrap = await fetchBootstrap(coldRender.url);
        expect(typeof coldBootstrap.codeHash).toBe('string');
        expect(coldBootstrap.codeHash!.length).toBeGreaterThan(0);

        // ── 3. Warm handshake — paraphrased intent, same draft ─────
        // The new fast path runs matchBlueprint exact-key on the
        // draft; the slot is now populated; origin: 'cache' fires.
        const warmHandshakeStart = Date.now();
        const warmHandshake = await handshakeFresh(COLD_PATH_INTENT_PARAPHRASED);
        const warmHandshakeLatencyMs = Date.now() - warmHandshakeStart;

        expect(warmHandshake.suggestion.origin).toBe('cache');
        expect(typeof warmHandshake.suggestion.blueprintMeta.codeHash).toBe('string');
        expect(warmHandshake.suggestion.blueprintMeta.codeHash!.length).toBeGreaterThan(0);

        // The bytes the handshake hashed are the SAME bytes that the
        // bootstrap on step 2 served — both go through
        // sha256(componentCode). Equality proves the fast path
        // matched the right slot (not, say, a stale row from another
        // scenario).
        expect(warmHandshake.suggestion.blueprintMeta.codeHash).toBe(
          coldBootstrap.codeHash,
        );

        // Handshake on cache hit must skip LLM — see scenario 17 for
        // the same budget rationale.
        expect(warmHandshakeLatencyMs).toBeLessThan(3_000);

        // ── 4. Warm render (accept) — reuses cached bytes ──────────
        const warmRenderStart = Date.now();
        const warmRender = unwrapStructured<RenderOut>(
          await callTool(MCP_URL, 'ggui_render', {
            handshakeId: warmHandshake.handshakeId,
            decision: { kind: 'accept' },
          }),
        );
        const warmRenderLatencyMs = Date.now() - warmRenderStart;
        const warmBootstrap = await fetchBootstrap(warmRender.url);

        expect(warmBootstrap.codeHash).toBe(coldBootstrap.codeHash);
        expect(warmBootstrap.codeUrl).toBe(coldBootstrap.codeUrl);
        expect(warmRenderLatencyMs).toBeLessThan(5_000);
      },
      300_000,
    );
  },
);
