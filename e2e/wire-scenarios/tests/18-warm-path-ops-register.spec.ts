/**
 * Scenario 18 — warm path via `/ops` registration (zero-LLM priming).
 *
 * What this proves: `ggui_ops_register_blueprint` lands operator-
 * supplied componentCode bytes into BOTH the MVB BlueprintStore AND
 * the cache vectorStore. The agent-facing handshake matchBlueprint
 * fast path then finds the row on first contact — even with a
 * paraphrased intent — and render.accept reuses the cached bytes.
 *
 * Distinct from scenario 17 (cold→warm via render.override priming):
 *   - Scenario 17 primes through the agent flow (render runs the LLM).
 *   - Scenario 18 primes through the ops flow with PRE-BUILT bytes
 *     (no LLM call on the priming side).
 *
 * `ggui_ops_register_blueprint` is the operator-class sibling of
 * `ggui_ops_generate_blueprint` — same dual-write persistence + same
 * variance/default-pin semantics, but the componentCode is supplied
 * verbatim instead of dispatched through a UiGenerator.
 *
 * Flow:
 *   1. POST `/ops` `ggui_ops_register_blueprint({contract, componentCode})`
 *      — no LLM, sub-second.
 *   2. `/mcp` `ggui_handshake({intent: paraphrased,
 *      blueprintDraft: {contract: <same>}})`.
 *      Assert: `suggestion.origin === 'cache'`,
 *      `blueprintMeta.codeHash === sha256(componentCode)`.
 *   3. `ggui_render({handshakeId, decision: {kind: 'accept'}})`.
 *      Assert: `bootstrap.codeHash === <same sha256>`, render latency
 *      < 5s.
 *
 * Runs in seconds — no ANTHROPIC_API_KEY required for the priming
 * side. The handshake negotiator still tries to resolve creds, but
 * the matchBlueprint fast path fires BEFORE the creds resolve so the
 * scenario lands `origin: 'cache'` even without a key. We keep the
 * HAS_KEY gate off so the scenario is always-on coverage for the
 * register tool.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const OPS_URL = `http://localhost:${GGUI_PORT}/ops`;

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

interface OpsRegisterOut {
  blueprintId: string;
  codeHash: string;
  generator: string;
}

/**
 * Unique-per-test contract — same posture as scenarios 8/16/17. The
 * description string is the only varying field so blueprintKey is
 * unique to this scenario's registry slot.
 */
const REGISTER_TEST_CONTRACT = {
  propsSpec: {
    description: 'register-test scenario 18 — unique signature',
    properties: {
      label: {
        schema: { type: 'string' },
        required: false,
        description: 'optional label',
      },
    },
  },
} as const;

const REGISTER_TEST_COMPONENT_CODE =
  "export default function PreBuiltCard() { return null; }\n";

function bootstrapUrlFromRenderUrl(renderUrl: string | undefined): string {
  if (typeof renderUrl !== 'string') {
    throw new Error(`render output missing url: ${String(renderUrl)}`);
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
  const out: BootstrapJson = {};
  if (typeof renderSlice['codeUrl'] === 'string') out.codeUrl = renderSlice['codeUrl'];
  if (typeof renderSlice['codeHash'] === 'string') out.codeHash = renderSlice['codeHash'];
  return out;
}

describe(
  'Scenario 18 — warm path: /ops register (pre-built code) → handshake matches → render.accept',
  () => {
    test(
      'register tool lands componentCode in both registries; handshake + render.accept reuse it',
      async () => {
        const expectedCodeHash = createHash('sha256')
          .update(REGISTER_TEST_COMPONENT_CODE)
          .digest('hex');

        // ── 1. /ops register — no LLM, sub-second ─────────────────
        const ops = unwrapStructured<OpsRegisterOut>(
          await callTool(OPS_URL, 'ggui_ops_register_blueprint', {
            contract: REGISTER_TEST_CONTRACT,
            componentCode: REGISTER_TEST_COMPONENT_CODE,
          }),
        );
        expect(typeof ops.blueprintId).toBe('string');
        expect(ops.blueprintId.length).toBeGreaterThan(0);
        // The handler computes the full 64-char sha256 of the
        // operator-supplied bytes verbatim. Same hash the handshake
        // negotiator + bootstrap will surface.
        expect(ops.codeHash).toBe(expectedCodeHash);

        // ── 2. Handshake with paraphrased intent ──────────────────
        const handshakeStart = Date.now();
        const handshake = unwrapStructured<HandshakeOut>(
          await callTool(MCP_URL, 'ggui_handshake', {
            intent: 'a label badge — different phrasing than the priming side',
            blueprintDraft: { contract: REGISTER_TEST_CONTRACT },
          }),
        );
        const handshakeLatencyMs = Date.now() - handshakeStart;

        expect(handshake.suggestion.origin).toBe('cache');
        expect(handshake.suggestion.blueprintMeta.codeHash).toBe(expectedCodeHash);
        // Cache hit must skip the synth-LLM round-trip.
        expect(handshakeLatencyMs).toBeLessThan(3_000);

        // ── 3. render.accept reuses the cached blueprint ──────────
        const renderStart = Date.now();
        const render = unwrapStructured<RenderOut>(
          await callTool(MCP_URL, 'ggui_render', {
            handshakeId: handshake.handshakeId,
            decision: { kind: 'accept' },
          }),
        );
        const renderLatencyMs = Date.now() - renderStart;
        const bootstrap = await fetchBootstrap(render.url);

        expect(bootstrap.codeHash).toBe(expectedCodeHash);
        expect(renderLatencyMs).toBeLessThan(5_000);
      },
      60_000,
    );
  },
);
