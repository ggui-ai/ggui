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
 * **Cross-render cache:** each `renderOnce` mints a fresh handshake +
 * render. The blueprint registry's cache key is `(appId, kind,
 * blueprintKey(contract))` — no per-render scoping. Both calls hash
 * to the same appId (`local` per dev defaults) and identical contract
 * bytes, so the second render's exact-key lookup hits. This matches
 * the production scenario the user encounters most often: claude.ai
 * opens a new chat → same UI request → expect instant cache hit
 * instead of re-paying cold-gen.
 *
 * **Why `override.contract` instead of accept (omitting override).** The
 * cache is keyed on `blueprintKey(effectiveContract)`. On the accept path
 * `effectiveContract` comes from the LLM-backed negotiator's proposed
 * contract, which is NOT byte-deterministic across separate API
 * round-trips even at temperature 0 (server-side sampling jitter can
 * shift a description string, reorder fields, etc.). When that drifts,
 * `blueprintKey` diverges, exact-key misses (Slice 18e gate disables
 * semantic fall-through when a contract is supplied), cold-gen fires
 * fresh, codeHash differs, test fails.
 *
 * `override.contract` passes the LITERAL draft on render. `story.contract`
 * becomes the exact draft we sent — byte-identical between renders — so
 * `blueprintKey` collides and the cache exact-key hits. This test now
 * tests the CACHE LAYER honestly, decoupled from negotiator determinism.
 *
 * The signal is `/api/bootstrap/<shortCode>.codeHash` — that's the
 * hash the iframe-runtime fetches, so identical bytes across renders
 * ⇒ identical hash. The C-series trim hid `codeHash` from `ggui_render`
 * output but the JSON bootstrap endpoint still exposes it
 * (load-bearing for the iframe boot flow).
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
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import { BANNER_CONTRACT, BANNER_INTENT } from '../fixtures/cache-contracts.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

interface RenderOut {
  renderId: string;
  url?: string;
  action?: string;
}

interface BootstrapJson {
  codeUrl?: string;
  codeHash?: string;
  renderId?: string;
}

function bootstrapUrlFromRenderUrl(renderUrl: string | undefined): string {
  if (typeof renderUrl !== 'string') {
    throw new Error(`render output missing url: ${String(renderUrl)}`);
  }
  // Render URL shape: `<base>/r/<shortCode>?sig=...&exp=...`. Rewrite the
  // host to match the local dev port, preserve path + signed query.
  // R4: `/api/bootstrap/:shortCode` retired — content-negotiated JSON
  // branch of `/r/:shortCode` covers the same surface.
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
  const envelope = (await resp.json()) as Record<string, unknown>;
  // Flatten the slice-envelope into the test's legacy BootstrapJson shape.
  const renderSlice =
    (envelope['ai.ggui/render'] as Record<string, unknown> | undefined) ??
    {};
  return {
    codeUrl: typeof renderSlice['codeUrl'] === 'string' ? renderSlice['codeUrl'] : undefined,
    codeHash: typeof renderSlice['codeHash'] === 'string' ? renderSlice['codeHash'] : undefined,
    renderId:
      typeof renderSlice['renderId'] === 'string' ? renderSlice['renderId'] : undefined,
  };
}

async function renderOnce(opts: {
  intent: string;
}): Promise<{ out: RenderOut; latencyMs: number; bootstrap: BootstrapJson }> {
  // Fresh handshake per call — the cache key is (appId, contractKey),
  // handshake-independent, so this proves the cross-render hit path.
  const handshake = unwrapStructured<{ handshakeId: string }>(
    await callTool(MCP_URL, 'ggui_handshake', {
      intent: opts.intent,
      blueprintDraft: { contract: BANNER_CONTRACT },
    }),
  );
  const start = Date.now();
  // `override.contract` so `story.contract` = the LITERAL draft on both
  // renders. The negotiator's potentially-non-deterministic proposed
  // contract is bypassed; only the cache layer is under test here. See
  // file-level docstring for the determinism gap.
  const out = unwrapStructured<RenderOut>(
    await callTool(MCP_URL, 'ggui_render', {
      handshakeId: handshake.handshakeId,
      props: { title: 'Hello' },
      override: { contract: BANNER_CONTRACT },
    }),
  );
  const latencyMs = Date.now() - start;
  const bootstrap = await fetchBootstrap(out.url);
  return { out, latencyMs, bootstrap };
}

describe.skipIf(!HAS_KEY)('Scenario 8 — cached render (warm path)', () => {
  test(
    'second render with same intent hits cache + emits identical codeHash',
    async () => {
      const cold = await renderOnce({ intent: BANNER_INTENT });
      expect(cold.out.renderId).toBeTruthy();
      expect(typeof cold.out.url).toBe('string');
      expect(typeof cold.bootstrap.codeHash).toBe('string');
      expect(cold.bootstrap.codeHash?.length).toBeGreaterThan(0);

      const warm = await renderOnce({ intent: BANNER_INTENT });
      expect(warm.out.renderId).toBeTruthy();
      expect(typeof warm.bootstrap.codeHash).toBe('string');

      // STRUCTURAL cache-hit signal: identical componentCode bytes →
      // identical sha256 → identical codeUrl. This is the contract
      // the iframe-runtime actually depends on (it dynamic-imports
      // the URL); if two renders with the same intent diverge here,
      // the renderer can't be deterministic across reloads.
      expect(warm.bootstrap.codeHash).toBe(cold.bootstrap.codeHash);
      expect(warm.bootstrap.codeUrl).toBe(cold.bootstrap.codeUrl);

      // Weak latency corroborator: warm should at least not require a
      // fresh 10–60s LLM call. 5s budget covers the non-LLM path
      // (handshake + render + codeStore put + bootstrap fetch).
      expect(warm.latencyMs).toBeLessThan(5_000);
    },
    180_000,
  );
});
