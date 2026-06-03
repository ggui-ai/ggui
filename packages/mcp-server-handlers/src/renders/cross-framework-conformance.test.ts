/**
 * Cross-framework conformance — the deterministic gate proving tool-identity
 * canonicalization CONVERGES blueprint identity across agent frameworks.
 *
 * The premise: three different agent SDKs author the SAME bare tool
 * (`todo_add`) with THREE different `serverInfo.name` shapes —
 *   - draft-A: the config-key (`'todo'`) — what claude/openai authored from
 *     the `mcp__todo__` prefix,
 *   - draft-B: serverInfo OMITTED — a bare-name framework that authors none,
 *   - draft-C: a FABRICATED name (`'todo-mcp-server'`) — a weak model's guess.
 * Everything else (propsSpec, actionSpec, the tool's inputSchema) is identical.
 *
 * Tier 1 (catalog declared): all three MUST collapse to ONE blueprint identity,
 * because the per-app catalog rewrites every authored serverInfo to the canonical
 * `initialize` value before keying. This is the conformance claim — reuse is
 * framework-invariant.
 *
 * Tier 2 (no catalog): the three authored names differ, so they MUST NOT all
 * collapse to one identity. This proves the boundary — canonicalization is what
 * earns the convergence, not an accident of the contract shape.
 *
 * The identity is asserted on `blueprintKey(canonicalizeToolIdentity(draft, catalog))`
 * — the exact 16-char contract hash that keys the registry's exact-match tier.
 * The integration through `decideHandshake` (catalog resolution → canonicalize
 * → match probe reads the canonical contract) is separately locked in
 * `decide-handshake.test.ts`'s "tool identity canonicalization (Slice 2)" block;
 * here we pin the identity-convergence property end-to-end on the real keying
 * functions (no mocks).
 */
import { describe, it, expect } from 'vitest';
import { dataContractSchema, type DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  canonicalizeToolIdentity,
  type ToolIdentityCatalog,
} from './canonicalize-tool-identity.js';

/**
 * Build a draft contract identical in every respect EXCEPT the authored
 * `serverInfo` on the shared `todo_add` tool. `serverName === undefined`
 * omits `serverInfo` entirely (the bare-name framework case).
 */
function draftWithServerName(serverName: string | undefined): DataContract {
  return {
    propsSpec: {
      properties: { title: { schema: { type: 'string' }, required: true } },
    },
    actionSpec: {
      add: { label: 'Add', nextStep: 'todo_add' },
    },
    agentCapabilities: {
      tools: {
        todo_add: {
          ...(serverName !== undefined
            ? { serverInfo: { name: serverName } }
            : {}),
          toolInfo: {
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        },
      },
    },
  };
}

// The three SDK-shaped authorings of the same tool.
const DRAFT_A = draftWithServerName('todo'); // config-key (claude/openai)
const DRAFT_B = draftWithServerName(undefined); // omitted (bare-name framework)
const DRAFT_C = draftWithServerName('todo-mcp-server'); // fabricated

// Tier-1 catalog: the bare tool → its server's canonical `initialize` identity.
const CATALOG: ToolIdentityCatalog = {
  todo_add: { name: '@ggui-samples/mcp-todo', version: '0.0.1' },
};

/** The blueprint identity of a draft AFTER canonicalizing against `catalog`. */
function canonicalIdentity(
  draft: DataContract,
  catalog: ToolIdentityCatalog,
): string {
  return blueprintKey(canonicalizeToolIdentity(draft, catalog));
}

describe('cross-framework conformance — tool identity canonicalization', () => {
  it('PREMISE: the three drafts differ ONLY in the authored serverInfo (raw keys diverge)', () => {
    // Sanity-check the fixtures: with no canonicalization, the three authored
    // names produce THREE distinct keys — there is a real divergence to close.
    const keyA = blueprintKey(DRAFT_A);
    const keyB = blueprintKey(DRAFT_B);
    const keyC = blueprintKey(DRAFT_C);
    expect(new Set([keyA, keyB, keyC]).size).toBe(3);
    // And each draft is a valid DataContract (so the convergence is over real
    // contracts, not malformed input the schema would reject).
    expect(dataContractSchema.safeParse(DRAFT_A).success).toBe(true);
    expect(dataContractSchema.safeParse(DRAFT_B).success).toBe(true);
    expect(dataContractSchema.safeParse(DRAFT_C).success).toBe(true);
  });

  it('TIER 1 (catalog declared): all three converge to ONE blueprint identity', () => {
    const idA = canonicalIdentity(DRAFT_A, CATALOG);
    const idB = canonicalIdentity(DRAFT_B, CATALOG);
    const idC = canonicalIdentity(DRAFT_C, CATALOG);
    // The exact equality the conformance claim rests on: config-key, omitted,
    // and fabricated authorings all collapse onto the canonical identity.
    expect(idA).toBe(idB);
    expect(idB).toBe(idC);
    expect(new Set([idA, idB, idC]).size).toBe(1);
    // And the converged key is exactly the key of the canonical authoring —
    // canonicalization rewrites every draft to the `initialize` identity.
    const canonicalDraft = draftWithServerName('@ggui-samples/mcp-todo');
    expect(idA).toBe(blueprintKey(canonicalDraft));
  });

  it('TIER 1: convergence is independent of catalog serverInfo.version (metadata, not identity)', () => {
    // A version bump in the catalog MUST NOT change the converged identity —
    // `serverInfo.version` is stripped from the hash; only `name` is identity.
    const bumped: ToolIdentityCatalog = {
      todo_add: { name: '@ggui-samples/mcp-todo', version: '9.9.9' },
    };
    const idDefault = canonicalIdentity(DRAFT_A, CATALOG);
    const idBumped = canonicalIdentity(DRAFT_A, bumped);
    expect(idBumped).toBe(idDefault);
  });

  it('TIER 2 (no catalog): the three drafts do NOT all collapse to one identity', () => {
    // The boundary: without the catalog, the authored names differ → distinct
    // keys. (`{}` is the no-op catalog — canonicalizeToolIdentity rewrites
    // nothing, mirroring the Tier-2 "no catalog declared" handshake path.)
    const empty: ToolIdentityCatalog = {};
    const idA = blueprintKey(canonicalizeToolIdentity(DRAFT_A, empty));
    const idB = blueprintKey(canonicalizeToolIdentity(DRAFT_B, empty));
    const idC = blueprintKey(canonicalizeToolIdentity(DRAFT_C, empty));
    // Not all equal — at least two distinct identities survive. (Here all
    // three are distinct, but the conformance boundary only requires that
    // they do NOT all converge.)
    expect(new Set([idA, idB, idC]).size).toBeGreaterThan(1);
  });
});
