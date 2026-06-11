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
 *   2. `ggui_render({handshakeId, props: {}, override: {contract:
 *      COLD_PATH_CONTRACT}})`. `override.contract` forces render to
 *      STRICT cold-gen against the LITERAL draft (not the negotiator's
 *      potentially-amended effectiveContract) and registers
 *      `template:${blueprintKey(COLD_PATH_CONTRACT)}`.
 *      Capture the cold render's `codeHash` off its
 *      `_meta["ai.ggui/render"]` slice.
 *   3. `ggui_handshake({intent: COLD_PATH_INTENT_PARAPHRASED,
 *      blueprintDraft: {contract: COLD_PATH_CONTRACT}})`.
 *      Assert: `suggestion.origin === 'cache'`,
 *      `blueprintMeta.codeHash` present.
 *   4. `ggui_render({handshakeId, props: {}})`  // accept: override omitted.
 *      Assert: warm render slice `codeHash` (and `codeUrl`) equal the
 *      cold render's AND warm render latency < 5s.
 *
 * **Why override on step 2, not accept**: the OSS negotiator's synth
 * runs on every cold handshake and may amend the draft (e.g. add a
 * required field). If step 2 omitted `override` (accept path),
 * `effectiveContract` would be the amended contract, render would
 * register under `blueprintKey(amended)`, and step 3's handshake against
 * the literal draft would key-miss. `override.contract` pins the
 * registered contract to the literal draft so step 3's handshake
 * exact-key matches.
 *
 * ## Obligation remapping (2026-06-11 retired-surfaces port)
 *
 * All cold/warm assertions are UNCHANGED; what moved is where the
 * render-side `codeHash`/`codeUrl` are read. This spec used to fetch
 * the content-negotiated bootstrap JSON from the render's
 * `/r/<shortCode>` URL — both retired: the R5 retirement removed the
 * `/r/<shortCode>` HTTP surface, and `ggui_render`'s wire output
 * carries no `url` (zod strips `codeUrl`/`codeHash` from
 * `structuredContent`). The live surface is the render response's
 * `_meta["ai.ggui/render"]` slice — the single `deriveRenderMeta`-fed
 * projection (docs/principles/mcp-apps-compliance.md) — which carries
 * the same `codeUrl` + `codeHash` the retired bootstrap JSON did.
 * Narrowed at the trust boundary via the protocol's own
 * `parseMcpAppAiGguiRenderMeta`. The handshake-side
 * `suggestion.blueprintMeta.codeHash` reads are live, unretired wire
 * fields and are untouched.
 *
 * Gated on `ANTHROPIC_API_KEY` — step 2 cold-gens once.
 */
import { describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import { readRenderCodeRef } from '../fixtures/render-contract.js';
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
  source?:
    | { kind: 'llm'; generator: string; model: string }
    | { kind: 'user' }
    | { kind: 'curated' };
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
  sessionId: string;
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
        const coldRenderResp = await callTool(MCP_URL, 'ggui_render', {
          handshakeId: coldHandshake.handshakeId,
          props: {},
          override: { contract: COLD_PATH_CONTRACT },
        });
        unwrapStructured<RenderOut>(coldRenderResp);
        const coldCode = readRenderCodeRef(coldRenderResp);
        expect(typeof coldCode.codeHash).toBe('string');
        const coldCodeHash = coldCode.codeHash;
        if (coldCodeHash === undefined || coldCodeHash.length === 0) {
          throw new Error(
            'cold render carried no codeHash on its ai.ggui/render slice',
          );
        }

        // ── 3. Warm handshake — paraphrased intent, same draft ─────
        // The new fast path runs matchBlueprint exact-key on the
        // draft; the slot is now populated; origin: 'cache' fires.
        const warmHandshakeStart = Date.now();
        const warmHandshake = await handshakeFresh(COLD_PATH_INTENT_PARAPHRASED);
        const warmHandshakeLatencyMs = Date.now() - warmHandshakeStart;

        expect(warmHandshake.suggestion.origin).toBe('cache');
        expect(typeof warmHandshake.suggestion.blueprintMeta.codeHash).toBe('string');
        expect(warmHandshake.suggestion.blueprintMeta.codeHash!.length).toBeGreaterThan(0);

        // The bytes the handshake hashed are the SAME bytes the cold
        // render's slice surfaced on step 2 — both go through
        // sha256(componentCode). Equality proves the fast path
        // matched the right slot (not, say, a stale row from another
        // scenario).
        expect(warmHandshake.suggestion.blueprintMeta.codeHash).toBe(
          coldCodeHash,
        );

        // Handshake on cache hit must skip LLM — see scenario 18 for
        // the same budget rationale.
        expect(warmHandshakeLatencyMs).toBeLessThan(3_000);

        // ── 4. Warm render (accept) — reuses cached bytes ──────────
        const warmRenderStart = Date.now();
        const warmRenderResp = await callTool(MCP_URL, 'ggui_render', {
          handshakeId: warmHandshake.handshakeId,
          props: {},
        });
        unwrapStructured<RenderOut>(warmRenderResp);
        const warmRenderLatencyMs = Date.now() - warmRenderStart;
        const warmCode = readRenderCodeRef(warmRenderResp);

        expect(warmCode.codeHash).toBe(coldCodeHash);
        expect(warmCode.codeUrl).toBe(coldCode.codeUrl);
        expect(warmRenderLatencyMs).toBeLessThan(5_000);
      },
      300_000,
    );
  },
);
