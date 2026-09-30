/**
 * ggui#1568 — a deployment may exclude rows from the SEMANTIC tier. An
 * excluded row is never offered to the judge and never returned as a
 * semantic candidate, even to a request carrying its own intent, while it
 * stays reachable by its exact key. The rows are named by
 * `(contractKey, variantKey)`, the key the exact tier already resolves.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { BlueprintVariance, DataContract } from '@ggui-ai/protocol';
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import type { LLMCaller, ToolSchema } from '@ggui-ai/negotiator';
import { matchBlueprint, semanticExclusionKey } from './blueprint-matcher.js';
import { registerBlueprint } from './blueprint-registry.js';

const SCOPE = 'app-exclusion';
const CONTRACT: DataContract = {
  contextSpec: { noteText: { schema: { type: 'string' }, default: '' } },
};
const OTHER_CONTRACT: DataContract = {
  contextSpec: { title: { schema: { type: 'string' }, default: '' } },
};
const EXCLUDED_VARIANCE: BlueprintVariance = { persona: 'excluded-row' };
const INTENT = 'a notepad with a bold headline for quick bug notes';
const NO_COSINE_GATE = { minCosineForRerank: -1 };

function makeRegistry() {
  return {
    embedding: new MockEmbeddingProvider(),
    vectorStore: new InMemoryVectorStore(),
    index: new InMemoryBlueprintIndex(),
  };
}

/**
 * A judge that picks the FIRST candidate it is offered, and records every
 * user message it saw (the candidate list rides in it).
 */
function firstPickJudge(seen: string[]): LLMCaller {
  return {
    async call() {
      throw new Error('text-mode not used');
    },
    async callStructured(_system: string, user: string, _tool: ToolSchema): Promise<unknown> {
      seen.push(user);
      const m = /bp_[0-9a-f-]+/.exec(user);
      return { matchId: m?.[0] ?? null, confidence: 0.9, reason: 'first offered' };
    },
  };
}

async function registerExcludedRow(registry: ReturnType<typeof makeRegistry>) {
  return registerBlueprint(registry, SCOPE, {
    kind: 'template',
    contract: CONTRACT,
    intent: INTENT,
    variance: EXCLUDED_VARIANCE,
    componentCode: 'excluded',
    source: { kind: 'user' },
  });
}

const EXCLUDED_KEY = semanticExclusionKey(blueprintKey(CONTRACT), variantKey(EXCLUDED_VARIANCE));

describe('matchBlueprint — a deployment-excluded row is never a semantic candidate (ggui#1568)', () => {
  it('control: without the exclusion, the row is offered and reused', async () => {
    const registry = makeRegistry();
    const row = await registerExcludedRow(registry);
    const seen: string[] = [];
    const result = await matchBlueprint(
      { registry, llm: firstPickJudge(seen) },
      SCOPE,
      { intent: INTENT },
      NO_COSINE_GATE,
    );
    expect(result.strategy).toBe('semantic');
    expect(seen.join('\n')).toContain(row.id);
  });

  it('an excluded row is never offered to the judge, even to a request carrying its own intent', async () => {
    const registry = makeRegistry();
    const row = await registerExcludedRow(registry);
    const seen: string[] = [];
    const result = await matchBlueprint(
      { registry, llm: firstPickJudge(seen) },
      SCOPE,
      { intent: INTENT },
      { ...NO_COSINE_GATE, excludeFromSemantic: new Set([EXCLUDED_KEY]) },
    );
    if (result.strategy !== 'no-match') throw new Error(`expected no-match, got ${result.strategy}`);
    expect(seen.join('\n')).not.toContain(row.id);
    expect(result.candidates.map((c) => c.blueprint.id)).not.toContain(row.id);
  });

  it('a contract-bearing request whose exact key misses does not fall through to an excluded row', async () => {
    const registry = makeRegistry();
    const row = await registerExcludedRow(registry);
    const seen: string[] = [];
    const result = await matchBlueprint(
      { registry, llm: firstPickJudge(seen) },
      SCOPE,
      { intent: INTENT, contract: CONTRACT },
      { ...NO_COSINE_GATE, excludeFromSemantic: new Set([EXCLUDED_KEY]) },
    );
    expect(result.strategy).toBe('no-match');
    expect(seen.join('\n')).not.toContain(row.id);
  });

  it('an excluded row stays reachable by its own exact key', async () => {
    const registry = makeRegistry();
    const row = await registerExcludedRow(registry);
    const result = await matchBlueprint(
      { registry },
      SCOPE,
      { intent: INTENT, contract: CONTRACT, variance: EXCLUDED_VARIANCE },
      { excludeFromSemantic: new Set([EXCLUDED_KEY]) },
    );
    expect(result.strategy).toBe('exact-key');
    if (result.strategy === 'exact-key') expect(result.blueprint.id).toBe(row.id);
  });

  it('a row the exclusion does not name is still offered beside an excluded one', async () => {
    const registry = makeRegistry();
    const excluded = await registerExcludedRow(registry);
    const kept = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: OTHER_CONTRACT,
      intent: INTENT,
      componentCode: 'kept',
      source: { kind: 'user' },
    });
    const seen: string[] = [];
    const result = await matchBlueprint(
      { registry, llm: firstPickJudge(seen) },
      SCOPE,
      { intent: INTENT },
      { ...NO_COSINE_GATE, excludeFromSemantic: new Set([EXCLUDED_KEY]) },
    );
    expect(result.strategy).toBe('semantic');
    if (result.strategy === 'semantic') expect(result.blueprint.id).toBe(kept.id);
    expect(seen.join('\n')).not.toContain(excluded.id);
  });

  it('a reserved row does not take a top-K slot: the pool the judge ranks stays topK deep', async () => {
    const registry = makeRegistry();
    const excluded = await registerExcludedRow(registry);
    // Same contract, another variance and intent: the exact tier misses it
    // for a request without variance, and data-shape fits it.
    const kept = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: CONTRACT,
      intent: 'a small card that shows a single headline',
      variance: { persona: 'kept-row' },
      componentCode: 'kept',
      source: { kind: 'user' },
    });
    // The composed query equals the reserved row's own embedding input, so
    // it ranks first (cosine 1). Control: at topK 1 it is the row retrieved.
    const query = { intent: INTENT, contract: CONTRACT };
    const control = await matchBlueprint(
      { registry, llm: firstPickJudge([]) },
      SCOPE,
      query,
      { ...NO_COSINE_GATE, topK: 1 },
    );
    expect(control.strategy === 'semantic' ? control.blueprint.id : null).toBe(excluded.id);

    const result = await matchBlueprint(
      { registry, llm: firstPickJudge([]) },
      SCOPE,
      query,
      { ...NO_COSINE_GATE, topK: 1, excludeFromSemantic: new Set([EXCLUDED_KEY]) },
    );
    expect(result.strategy === 'semantic' ? result.blueprint.id : null).toBe(kept.id);
  });

  it('when every retrieved row is reserved, the reason does not claim the scope is empty', async () => {
    const registry = makeRegistry();
    await registerExcludedRow(registry);
    const result = await matchBlueprint(
      { registry, llm: firstPickJudge([]) },
      SCOPE,
      { intent: INTENT },
      { ...NO_COSINE_GATE, excludeFromSemantic: new Set([EXCLUDED_KEY]) },
    );
    expect(result.strategy).toBe('no-match');
    expect(result.reason).not.toContain('first registration');
  });

  it("a tier turned off for an unknown reserved-row list says so, never 'exact-only policy'", async () => {
    const registry = makeRegistry();
    await registerExcludedRow(registry);
    const off = await matchBlueprint(
      { registry, llm: firstPickJudge([]) },
      SCOPE,
      { intent: INTENT },
      { disableSemantic: true, disableSemanticCause: 'exclusion-unavailable' },
    );
    expect(off.strategy).toBe('no-match');
    expect(off.reason).not.toContain('exact-only');
    // Control: the policy cause (and the default) still name the policy.
    const policy = await matchBlueprint({ registry }, SCOPE, { intent: INTENT }, { disableSemantic: true });
    expect(policy.reason).toContain('exact-only policy');
  });

  it('keys the pair unambiguously: no two different pairs share a key', () => {
    expect(semanticExclusionKey('ab', 'c')).not.toBe(semanticExclusionKey('a', 'bc'));
    expect(semanticExclusionKey('ab', 'c')).toBe(semanticExclusionKey('ab', 'c'));
  });
});
