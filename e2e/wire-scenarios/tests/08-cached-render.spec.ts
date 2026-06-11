/**
 * Scenario 8 — cached render (warm path, cross-render).
 *
 * Two renders with the SAME draft contract must produce IDENTICAL
 * componentCode bytes — the content-addressable codeStore gives the
 * same sha256 → same `/code/<hash>.js` URL → the iframe dynamic-imports
 * the exact same module on both. That structural identity IS the
 * protocol's cache-hit contract: deterministic UI for identical
 * contract, no LLM re-invocation.
 *
 * **Cross-render cache:** each render mints a fresh handshake. The
 * blueprint registry's cache key is `(appId, kind,
 * blueprintKey(contract))` — no per-render scoping. Both calls hash
 * to the same appId (`local` per dev defaults) and identical contract
 * bytes, so the second HANDSHAKE's exact-key lookup hits. This matches
 * the production scenario the user encounters most often: claude.ai
 * opens a new chat → same UI request → expect instant cache hit
 * instead of re-paying cold-gen.
 *
 * **Drive path (per the §6 reuse redesign).** Reuse rides the
 * HANDSHAKE decision, not the render: the warm handshake's registry
 * exact-key match returns `origin: 'cache'` + a stored
 * `matchedBlueprint`, and an ACCEPT render (override omitted)
 * point-reads that row by UUID and serves its componentCode verbatim.
 * `override.contract` is the STRICT fresh-contract path — it always
 * cold-gens by design ("a fresh contract; skip the point-read
 * entirely"). So:
 *
 *   - COLD primes via `override.contract` — the LITERAL draft becomes
 *     `story.contract`, byte-identical and negotiator-independent, so
 *     the registered row's `blueprintKey` is deterministic.
 *   - WARM goes handshake (asserted `origin: 'cache'`) → ACCEPT
 *     render. `origin: 'cache'` means the proposal IS the stored
 *     contract — the accept path is deterministic here precisely
 *     because no fresh LLM proposal is involved.
 *
 * (The pre-§6 version of this spec rendered `override.contract` twice
 * and relied on a render-side exact-key lookup — that render-side
 * matcher was deleted with the §6 redesign, so the second override
 * render now honestly cold-gens. Same obligation, new drive path.)
 *
 * **Signal surface (post-R4/R5 port).** The retired signal was
 * `/api/bootstrap/<shortCode>.codeHash`, later the content-negotiated
 * JSON branch of `/r/<shortCode>` — both gone (the `/r/<shortCode>`
 * path now serves the operator landing page, and `ggui_render`'s wire
 * output carries no URL). The live equivalent is the SAME projection
 * on the live transport: `deriveRenderMeta` stamps `codeUrl` +
 * `codeHash` on the `_meta["ai.ggui/render"]` slice of the
 * `ggui_render` tool result — the slice the iframe-runtime actually
 * boots from. Identical bytes across renders ⇒ identical hash there.
 * The retired `url`-presence assertion maps to its live obligation:
 * `resourceUri` (the spec-canonical MCP-Apps mount handle) is present
 * and non-empty on the LLM-visible structuredContent. The renders'
 * first-class `cache` marker + `blueprintId` (equal across renders ⟺
 * same stored component served) are asserted alongside the structural
 * codeHash signal — they're the wire's own statement of the same
 * contract.
 *
 * Latency stays as a weak corroborator: warm < 5s gives the server
 * room to do all the non-LLM work (handshake + render validation +
 * codeStore put + DB writes) while still flagging an obvious "real
 * LLM happened twice" regression.
 *
 * Gated on `ANTHROPIC_API_KEY` because the first (priming) render
 * still needs the real LLM to populate the cache.
 */
import { describe, expect, test } from 'vitest';
import { parseMcpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  callTool,
  unwrapStructured,
  type JsonRpcResponse,
} from '../fixtures/mcp-client.js';
import { BANNER_CONTRACT, BANNER_INTENT } from '../fixtures/cache-contracts.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

interface RenderOut {
  sessionId: string;
  resourceUri?: string;
  action?: string;
  blueprintId?: string;
  cache?: { hit?: boolean; kind?: string; reason?: string };
}

interface CodeIdentity {
  codeUrl?: string;
  codeHash?: string;
}

/**
 * Read `codeUrl` + `codeHash` off the render result's
 * `_meta["ai.ggui/render"]` slice via the protocol's own validating
 * parser — the same trust-boundary narrowing the iframe-runtime
 * applies before booting from the slice.
 */
function codeIdentityOf(resp: JsonRpcResponse): CodeIdentity {
  const parsed = parseMcpAppAiGguiRenderMeta(resp.result?._meta);
  if (!parsed.ok) {
    throw new Error(
      `ggui_render result _meta carries a malformed ai.ggui/render slice: ` +
        JSON.stringify(resp.result?._meta).slice(0, 400),
    );
  }
  if (parsed.meta === undefined) {
    throw new Error(
      'ggui_render result _meta carries no ai.ggui/render slice — ' +
        'the codeHash cache signal has no surface to read from.',
    );
  }
  return { codeUrl: parsed.meta.codeUrl, codeHash: parsed.meta.codeHash };
}

interface RenderResult {
  out: RenderOut;
  latencyMs: number;
  code: CodeIdentity;
  handshakeOrigin?: string;
}

async function renderOnce(opts: {
  intent: string;
  /**
   * `'override'` — pin the LITERAL draft via `override.contract`
   * (STRICT path; always cold-gens; deterministic `blueprintKey`).
   * `'accept'` — omit `override` so the render ACCEPTS the handshake's
   * proposal; with `origin: 'cache'` this is the §6 point-read reuse
   * path.
   */
  mode: 'override' | 'accept';
}): Promise<RenderResult> {
  // Fresh handshake per call — the cache key is (appId, contractKey),
  // handshake-independent, so this proves the cross-render hit path.
  const handshake = unwrapStructured<{
    handshakeId: string;
    suggestion?: { origin?: string };
  }>(
    await callTool(MCP_URL, 'ggui_handshake', {
      intent: opts.intent,
      blueprintDraft: { contract: BANNER_CONTRACT },
    }),
  );
  const start = Date.now();
  const resp = await callTool(MCP_URL, 'ggui_render', {
    handshakeId: handshake.handshakeId,
    props: { title: 'Hello' },
    ...(opts.mode === 'override'
      ? { override: { contract: BANNER_CONTRACT } }
      : {}),
  });
  const latencyMs = Date.now() - start;
  const out = unwrapStructured<RenderOut>(resp);
  const code = codeIdentityOf(resp);
  return {
    out,
    latencyMs,
    code,
    ...(handshake.suggestion?.origin !== undefined
      ? { handshakeOrigin: handshake.suggestion.origin }
      : {}),
  };
}

describe.skipIf(!HAS_KEY)('Scenario 8 — cached render (warm path)', () => {
  test(
    'second render with same intent hits cache + emits identical codeHash',
    async () => {
      const cold = await renderOnce({ intent: BANNER_INTENT, mode: 'override' });
      expect(cold.out.sessionId).toBeTruthy();
      // Live mapping of the retired url-presence assertion: the wire's
      // mount handle is the spec-canonical resourceUri.
      expect(typeof cold.out.resourceUri).toBe('string');
      expect(cold.out.resourceUri?.length).toBeGreaterThan(0);
      expect(typeof cold.code.codeHash).toBe('string');
      expect(cold.code.codeHash?.length).toBeGreaterThan(0);

      const warm = await renderOnce({ intent: BANNER_INTENT, mode: 'accept' });
      expect(warm.out.sessionId).toBeTruthy();
      // The warm handshake must have decided REUSE — that's the layer
      // the cache contract lives on post-§6. Failing here (origin
      // 'agent'/'synth') pinpoints a registry/exact-key regression
      // before the byte-identity assertions fire.
      expect(warm.handshakeOrigin).toBe('cache');
      expect(typeof warm.code.codeHash).toBe('string');

      // STRUCTURAL cache-hit signal: identical componentCode bytes →
      // identical sha256 → identical codeUrl. This is the contract
      // the iframe-runtime actually depends on (it dynamic-imports
      // the URL); if two renders with the same intent diverge here,
      // the renderer can't be deterministic across reloads.
      expect(warm.code.codeHash).toBe(cold.code.codeHash);
      expect(warm.code.codeUrl).toBe(cold.code.codeUrl);

      // Wire-level statement of the same contract: the render's own
      // cache marker reports the reuse, and blueprintId equality means
      // the SAME stored component was served (renderOutputSchema pins
      // that semantic).
      expect(warm.out.cache?.hit).toBe(true);
      expect(warm.out.blueprintId).toBe(cold.out.blueprintId);

      // Weak latency corroborator: warm should at least not require a
      // fresh 10–60s LLM call. 5s budget covers the non-LLM path
      // (handshake + render + codeStore put + slice projection).
      expect(warm.latencyMs).toBeLessThan(5_000);
    },
    180_000,
  );
});
