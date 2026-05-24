/**
 * Scenario 18 — warm path via `/ops` registration (zero-LLM priming).
 *
 * What this proves: `ggui_ops_register_blueprint` lands operator-
 * supplied componentCode bytes into BOTH the MVB BlueprintStore AND
 * the cache vectorStore. The agent-facing handshake matchBlueprint
 * fast path then finds the row on first contact — even with a
 * paraphrased intent — and push.accept reuses the cached bytes.
 *
 * Distinct from scenario 17 (cold→warm via push.override priming):
 *   - Scenario 17 primes through the agent flow (push runs the LLM).
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
 *   2. Fresh `/mcp` session. `ggui_handshake({intent: paraphrased,
 *      blueprintDraft: {contract: <same>}})`.
 *      Assert: `suggestion.origin === 'cache'`,
 *      `blueprintMeta.codeHash === sha256(componentCode)`.
 *   3. `ggui_push({handshakeId, decision: {kind: 'accept'}})`.
 *      Assert: `bootstrap.codeHash === <same sha256>`, push latency
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

interface PushOut {
  stackItemId: string;
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

function bootstrapUrlFromPushUrl(pushUrl: string | undefined): string {
  if (typeof pushUrl !== 'string') {
    throw new Error(`push output missing url: ${String(pushUrl)}`);
  }
  const parsed = new URL(pushUrl);
  const codeMatch = /^\/r\/([^/]+)$/.exec(parsed.pathname);
  if (!codeMatch || typeof codeMatch[1] !== 'string') {
    throw new Error(`url has no /r/<shortCode>: ${pushUrl}`);
  }
  return `http://localhost:${GGUI_PORT}/api/bootstrap/${codeMatch[1]}${parsed.search}`;
}

async function fetchBootstrap(pushUrl: string | undefined): Promise<BootstrapJson> {
  const resp = await fetch(bootstrapUrlFromPushUrl(pushUrl));
  if (!resp.ok) {
    throw new Error(
      `bootstrap fetch ${resp.status}: ${await resp.text().catch(() => '<no body>')}`,
    );
  }
  return (await resp.json()) as BootstrapJson;
}

describe(
  'Scenario 18 — warm path: /ops register (pre-built code) → handshake matches → push.accept',
  () => {
    test(
      'register tool lands componentCode in both registries; handshake + push.accept reuse it',
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

        // ── 2. Fresh session, handshake with paraphrased intent ───
        const session = unwrapStructured<{ sessionId: string }>(
          await callTool(MCP_URL, 'ggui_new_session', {}),
        );
        const handshakeStart = Date.now();
        const handshake = unwrapStructured<HandshakeOut>(
          await callTool(MCP_URL, 'ggui_handshake', {
            sessionId: session.sessionId,
            intent: 'a label badge — different phrasing than the priming side',
            blueprintDraft: { contract: REGISTER_TEST_CONTRACT },
          }),
        );
        const handshakeLatencyMs = Date.now() - handshakeStart;

        expect(handshake.suggestion.origin).toBe('cache');
        expect(handshake.suggestion.blueprintMeta.codeHash).toBe(expectedCodeHash);
        // Cache hit must skip the synth-LLM round-trip.
        expect(handshakeLatencyMs).toBeLessThan(3_000);

        // ── 3. push.accept reuses the cached blueprint ────────────
        const pushStart = Date.now();
        const push = unwrapStructured<PushOut>(
          await callTool(MCP_URL, 'ggui_push', {
            handshakeId: handshake.handshakeId,
            decision: { kind: 'accept' },
          }),
        );
        const pushLatencyMs = Date.now() - pushStart;
        const bootstrap = await fetchBootstrap(push.url);

        expect(bootstrap.codeHash).toBe(expectedCodeHash);
        expect(pushLatencyMs).toBeLessThan(5_000);
      },
      60_000,
    );
  },
);
