/**
 * Scenario 18 — warm path via `/control` registration (zero-LLM priming).
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
 *   1. POST `/control`
 *      `ggui_ops_register_blueprint({contract, componentCode, confirm})`
 *      — no LLM, sub-second. `register` is state-changing, so the
 *      control plane's confirmation gate requires `confirm: true`; an
 *      omitted flag returns a preview and writes nothing.
 *   2. `/mcp` `ggui_handshake({intent: paraphrased,
 *      blueprintDraft: {contract: <same>}})`.
 *      Assert: `suggestion.origin === 'cache'`,
 *      `blueprintMeta.codeHash === sha256(componentCode)`.
 *   3. `ggui_render({handshakeId, props: {}})`  // accept: override omitted.
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
import { readRenderCodeRef } from '../fixtures/render-contract.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const CONTROL_URL = `http://localhost:${GGUI_PORT}/control`;

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

interface OpsRegisterOut {
  blueprintId: string;
  codeHash: string;
  source: { kind: 'user' };
}

/**
 * Unique-per-test contract. NOTE (2026-08-16): the description string
 * does NOT make `blueprintKey` unique — canonicalization strips
 * `description`/`usage` by domain rule, so only the SHAPE (prop names,
 * arity, schemas, variance) keys the registry slot. Every scenario that
 * shares a server with this one (the keyless sweep: 27 primes before 18)
 * must therefore differ in shape, or its registration shadows this
 * one's on the exact-key fast path and the handshake below returns the
 * wrong codeHash. This shape — one optional string `label` — is
 * scenario 18's alone.
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

describe(
  'Scenario 18 — warm path: /control register (pre-built code) → handshake matches → render.accept',
  () => {
    test(
      'register tool lands componentCode in both registries; handshake + render.accept reuse it',
      async () => {
        const expectedCodeHash = createHash('sha256')
          .update(REGISTER_TEST_COMPONENT_CODE)
          .digest('hex');

        // ── 1. /control register — no LLM, sub-second ─────────────
        // The un-confirmed call is the gate's whole point: it must
        // preview and write nothing, so the priming below is provably
        // the confirmed call's doing.
        const preview = unwrapStructured<{ confirmationRequired?: boolean }>(
          await callTool(CONTROL_URL, 'ggui_ops_register_blueprint', {
            contract: REGISTER_TEST_CONTRACT,
            componentCode: REGISTER_TEST_COMPONENT_CODE,
          }),
        );
        expect(preview.confirmationRequired).toBe(true);

        const ops = unwrapStructured<OpsRegisterOut>(
          await callTool(CONTROL_URL, 'ggui_ops_register_blueprint', {
            contract: REGISTER_TEST_CONTRACT,
            componentCode: REGISTER_TEST_COMPONENT_CODE,
            confirm: true,
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
        const renderResp = await callTool(MCP_URL, 'ggui_render', {
          handshakeId: handshake.handshakeId,
          props: {},
        });
        const render = unwrapStructured<RenderOut>(renderResp);
        const renderLatencyMs = Date.now() - renderStart;
        expect(typeof render.sessionId).toBe('string');
        // Post-Phase-B: `ggui_render`'s structured output carries no
        // `url`/`codeHash` — the bootstrap payload rides on the
        // result's `_meta["ai.ggui/render"]` slice, narrowed by the
        // shared fixture via the protocol's own validating parser.
        const bootstrap = readRenderCodeRef(renderResp);

        expect(bootstrap.codeHash).toBe(expectedCodeHash);
        expect(renderLatencyMs).toBeLessThan(5_000);
      },
      60_000,
    );
  },
);
