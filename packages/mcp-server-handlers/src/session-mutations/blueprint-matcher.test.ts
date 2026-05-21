import { describe, it, expect, afterEach } from 'vitest';
import {
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import type { LLMCaller, ToolSchema } from '@ggui-ai/negotiator';
import { matchBlueprint } from './blueprint-matcher.js';
import { registerBlueprint } from './blueprint-registry.js';
import {
  setCacheTraceSink,
  type CacheTraceEvent,
  type CacheTraceSink,
} from './cache-trace-sink.js';

const SCOPE = 'app-test';

const NOTEPAD_CONTRACT: DataContract = {
  contextSpec: {
    noteText: { schema: { type: 'string' }, default: '' },
    topic: {
      schema: { type: 'string', enum: ['Bug', 'Feature', 'Question'] },
      default: 'Bug',
    },
  },
};

function makeRegistry() {
  return {
    embedding: new MockEmbeddingProvider(),
    vectorStore: new InMemoryVectorStore(),
  };
}

interface JudgeReturn {
  matchId: string | null;
  confidence: number;
  reason: string;
}

function stubLlm(
  ret: JudgeReturn | (() => JudgeReturn) | (() => Promise<JudgeReturn>),
): LLMCaller {
  return {
    async call() {
      throw new Error('text-mode not used');
    },
    async callStructured<T>(
      _system: string,
      _user: string,
      _tool: ToolSchema,
    ): Promise<T> {
      const value = typeof ret === 'function' ? await ret() : ret;
      return value as unknown as T;
    },
  };
}

describe('matchBlueprint — exact-key strategy', () => {
  it('returns match-exact on canonical-key equality', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'live notepad',
      componentCode: 'export default () => null;',
    });
    const result = await matchBlueprint(
      { registry },
      SCOPE,
      { intent: 'a paraphrased ask for a notepad', contract: NOTEPAD_CONTRACT },
    );
    expect(result.strategy).toBe('exact-key');
    if (result.strategy === 'exact-key') {
      expect(result.blueprint.contractKey).toBe(blueprintKey(NOTEPAD_CONTRACT));
      expect(result.cosine).toBe(1);
      expect(result.reason).toMatch(/match-exact/);
    }
  });

  it('falls through to no-match when contract is absent + LLM-less (semantic strategy with empty result)', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    // No contract → semantic strategy. Without LLM, judge skips.
    const result = await matchBlueprint({ registry }, SCOPE, {
      intent: 'something completely different',
    });
    expect(result.strategy).toBe('no-match');
  });
});

describe('matchBlueprint — semantic strategy (RAG + judge)', () => {
  // The mock embedder produces sine/cosine basis vectors that often
  // land below 0.3 cosine across distinct text — fine for production
  // (real bge-small embeds differently) but not for these unit tests
  // where we want to exercise the LLM-rerank path. Drop the gate to
  // -1 so candidates always reach the judge; the gate behaviour
  // itself is covered separately below.
  const NO_COSINE_GATE = { minCosineForRerank: -1 };

  it('returns match-semantic when judge accepts a candidate', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm({
          matchId: `template:${blueprintKey(NOTEPAD_CONTRACT)}`,
          confidence: 0.85,
          reason: 'paraphrase match',
        }),
      },
      SCOPE,
      { intent: 'a different prose form of notepad request' },
      NO_COSINE_GATE,
    );
    expect(result.strategy).toBe('semantic');
    if (result.strategy === 'semantic') {
      expect(result.judgeConfidence).toBeCloseTo(0.85);
      expect(result.reason).toMatch(/match-semantic/);
    }
  });

  it('no-match when judge rejects all candidates', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm({
          matchId: null,
          confidence: 0.1,
          reason: 'judge declined',
        }),
      },
      SCOPE,
      { intent: 'feedback form' },
      NO_COSINE_GATE,
    );
    expect(result.strategy).toBe('no-match');
    expect(result.reason).toMatch(/no-match: judge declined/);
    if (result.strategy === 'no-match') {
      expect(result.judgeReason).toMatch(/declined/);
    }
  });

  it('no-match-low-confidence when judge confidence below threshold', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm({
          matchId: `template:${blueprintKey(NOTEPAD_CONTRACT)}`,
          confidence: 0.5, // below default 0.6 threshold
          reason: 'low confidence match',
        }),
      },
      SCOPE,
      { intent: 'something' },
      NO_COSINE_GATE,
    );
    expect(result.strategy).toBe('no-match');
    expect(result.reason).toMatch(/no-match-low-confidence/);
  });

  it('match-skip-no-llm when no LLM is wired (judge skipped)', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    const result = await matchBlueprint(
      { registry },
      SCOPE,
      {
        intent: 'paraphrased notepad request',
        // No contract — exact-key skipped, semantic retrieves but no
        // LLM → skip.
      },
      NO_COSINE_GATE,
    );
    expect(result.strategy).toBe('no-match');
    if (result.strategy === 'no-match') {
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.reason).toMatch(/match-skip-no-llm/);
    }
  });

  it('match-skip-low-cosine when top-1 cosine below the rerank gate', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    let judgeCalled = false;
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm(() => {
          judgeCalled = true;
          return { matchId: null, confidence: 0, reason: '' };
        }),
      },
      SCOPE,
      { intent: 'totally unrelated topic chunk' },
      // Default minCosineForRerank=0.3 — mock embedder will produce
      // a low cosine on disparate texts and the gate fires.
      { minCosineForRerank: 0.99 },
    );
    expect(judgeCalled).toBe(false);
    expect(result.strategy).toBe('no-match');
    expect(result.reason).toMatch(/match-skip-low-cosine/);
  });
});

describe('matchBlueprint — no-match cases', () => {
  it('contract-bearing + canonical-key absent → no-match (Slice 18e gate)', async () => {
    // Contract supplied + canonical-key lookup misses → exact-key
    // strategy reports no-match. The judge can't safely match across
    // non-equal canonical contracts, so cold gen is the only
    // structurally-safe option.
    const registry = makeRegistry();
    const result = await matchBlueprint(
      { registry, llm: stubLlm({ matchId: null, confidence: 0, reason: '' }) },
      SCOPE,
      { intent: 'something', contract: NOTEPAD_CONTRACT },
    );
    expect(result.strategy).toBe('no-match');
    if (result.strategy === 'no-match') {
      expect(result.candidates).toEqual([]);
      expect(result.reason).toMatch(/no-match: contract supplied/);
    }
  });

  it('no-match-empty-intent on whitespace — short-circuits without backend round-trip', async () => {
    const registry = makeRegistry();
    const result = await matchBlueprint({ registry }, SCOPE, {
      intent: '   ',
    });
    expect(result.strategy).toBe('no-match');
    expect(result.reason).toMatch(/empty intent/);
  });
});

describe('matchBlueprint — kind isolation', () => {
  it('does not return atom-kind blueprints when querying with default kind=template', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'atom',
      contract: NOTEPAD_CONTRACT,
      intent: 'an atomic thing',
      componentCode: 'a',
    });
    const result = await matchBlueprint(
      { registry },
      SCOPE,
      { intent: 'paraphrase', contract: NOTEPAD_CONTRACT },
    );
    expect(result.strategy).toBe('no-match');
  });
});

describe('matchBlueprint — bumps hit count on hit', () => {
  it('increments hitCount on match-exact (best-effort)', async () => {
    const registry = makeRegistry();
    const initial = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    expect(initial.hitCount).toBe(0);
    await matchBlueprint({ registry }, SCOPE, {
      intent: 'paraphrased notepad',
      contract: NOTEPAD_CONTRACT,
    });
    // Wait for fire-and-forget bump to land.
    await new Promise((r) => setTimeout(r, 10));
    const entries = await registry.vectorStore.listByScope(SCOPE);
    const stored = entries.find((e) => e.key === initial.id);
    expect(stored?.metadata.hitCount).toBe(1);
  });
});

describe('matchBlueprint — judge picks unknown id (defense)', () => {
  it('falls through to no-match with diagnostic when judge picks an unknown id', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm({
          matchId: 'template:does-not-exist',
          confidence: 0.95,
          reason: 'judge hallucinated',
        }),
      },
      SCOPE,
      { intent: 'paraphrase' },
      { minCosineForRerank: -1 },
    );
    expect(result.strategy).toBe('no-match');
    if (result.strategy === 'no-match') {
      // rerankCandidates already filters unknown ids → matchId=null,
      // so we hit the judge-declined path with the reason from the
      // rerank module.
      expect(result.judgeReason).toMatch(/not in the candidate set/);
    }
  });
});

describe('matchBlueprint — cache-trace emit (Slice 16g)', () => {
  // The matcher MUST emit one CacheTraceEvent per call regardless of
  // outcome, so the operator devtool can render a strategy-aware
  // history. Strategy + decision + winning blueprint id are the
  // load-bearing fields the UI filters/groups by — pin them.

  let captured: CacheTraceEvent[] = [];

  function captureSink(): CacheTraceSink {
    return {
      emit(event) {
        captured.push(event);
      },
    };
  }

  afterEach(() => {
    setCacheTraceSink(null);
    captured = [];
  });

  it('emits match-exact with winningBlueprintId on canonical-key match', async () => {
    setCacheTraceSink(captureSink());
    const registry = makeRegistry();
    const stored = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    await matchBlueprint({ registry }, SCOPE, {
      intent: 'paraphrase',
      contract: NOTEPAD_CONTRACT,
    });
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.decision).toBe('match-exact');
    expect(ev.strategy).toBe('exact-key');
    expect(ev.winningBlueprintId).toBe(stored.id);
    expect(ev.expectedKey).toBe(blueprintKey(NOTEPAD_CONTRACT));
    expect(ev.scope).toBe(SCOPE);
    expect(ev.judgeConfidence).toBeUndefined();
  });

  it('emits no-match (exact-key strategy) when contract supplied + canonical-key absent (Slice 18e)', async () => {
    // Contract supplied → semantic strategy is unsafe (the cached
    // blueprint's wire surface ≠ the request's), so the matcher
    // reports no-match without paying for RAG retrieval. The trace
    // event records the strategy so operators can see why we didn't
    // try fuzzy match.
    setCacheTraceSink(captureSink());
    const registry = makeRegistry();
    await matchBlueprint({ registry }, SCOPE, {
      intent: 'something',
      contract: NOTEPAD_CONTRACT,
    });
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.decision).toBe('no-match');
    expect(ev.strategy).toBe('exact-key');
    expect(ev.winningBlueprintId).toBeUndefined();
  });

  it('emits no-match-empty-intent on whitespace intent without backend round-trip', async () => {
    setCacheTraceSink(captureSink());
    const registry = makeRegistry();
    await matchBlueprint({ registry }, SCOPE, { intent: '  ' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.decision).toBe('no-match-empty-intent');
    // No strategy was selected — short-circuit before branching.
    expect(captured[0]?.strategy).toBeUndefined();
    expect(captured[0]?.candidates).toEqual([]);
  });

  it('emits match-skip-no-llm with non-empty candidate list when LLM is absent', async () => {
    setCacheTraceSink(captureSink());
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    await matchBlueprint(
      { registry },
      SCOPE,
      { intent: 'paraphrased notepad' },
      { minCosineForRerank: -1 },
    );
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.decision).toBe('match-skip-no-llm');
    expect(ev.strategy).toBe('semantic');
    expect(ev.candidates.length).toBeGreaterThan(0);
  });

  it('emits match-semantic with judgeConfidence + winningBlueprintId on accepted candidate', async () => {
    setCacheTraceSink(captureSink());
    const registry = makeRegistry();
    const stored = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    await matchBlueprint(
      {
        registry,
        llm: stubLlm({
          matchId: stored.id,
          confidence: 0.85,
          reason: 'paraphrase match',
        }),
      },
      SCOPE,
      { intent: 'a different prose form of notepad request' },
      { minCosineForRerank: -1 },
    );
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.decision).toBe('match-semantic');
    expect(ev.strategy).toBe('semantic');
    expect(ev.winningBlueprintId).toBe(stored.id);
    expect(ev.judgeConfidence).toBeCloseTo(0.85);
    expect(ev.judgeReason).toBe('paraphrase match');
  });

  it('emits nothing when no sink is registered', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    // No setCacheTraceSink call — sink stays null.
    await matchBlueprint({ registry }, SCOPE, {
      intent: 'x',
      contract: NOTEPAD_CONTRACT,
    });
    expect(captured).toHaveLength(0);
  });
});

describe('matchBlueprint — Slice 18e (judge gated to contract-less requests)', () => {
  // Pins the structural-safety contract: contract-bearing requests
  // can ONLY hit match-exact (canonical-key equality) or fall to cold
  // gen. The judge — even when it WOULD accept a candidate — must not
  // serve across non-equal canonical contracts. The cached
  // componentCode is keyed to the cached blueprint's wire surface;
  // serving it under a different request's contract produces the
  // user-visible bug from 2026-05-09 (request: {increment, decrement,
  // reset} hit a 2-action {increment, reset} cached blueprint via
  // judge similarity 0.876 — rendered widget had no minus button).

  // Two paraphrased counter contracts that canonicalize differently
  // (different action names → different keys) but a permissive judge
  // would happily call them equivalent.
  const COUNTER_TWO_ACTIONS: DataContract = {
    actionSpec: {
      increment: {
        label: 'Increment',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
      reset: {
        label: 'Reset',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
  };
  const COUNTER_THREE_ACTIONS: DataContract = {
    actionSpec: {
      increment: {
        label: 'Increment',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
      decrement: {
        label: 'Decrement',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
      reset: {
        label: 'Reset',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
  };

  it('does NOT serve a subset cached blueprint to a contract-bearing request', async () => {
    // Setup: register the 2-action counter, then request a 3-action
    // counter. Pre-fix: judge would accept (similar shape, just
    // missing decrement). Post-fix: semantic strategy skipped,
    // returns no-match.
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: COUNTER_TWO_ACTIONS,
      intent: 'a counter widget',
      componentCode: 'export default () => <div/>;',
    });

    let judgeCalled = false;
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm(() => {
          // If the judge IS called, it would happily accept — pinning
          // the gate by its absence (judgeCalled stays false).
          judgeCalled = true;
          return {
            matchId: `template:${blueprintKey(COUNTER_TWO_ACTIONS)}`,
            confidence: 0.95,
            reason: 'similar counter shape',
          };
        }),
      },
      SCOPE,
      { intent: 'a counter widget', contract: COUNTER_THREE_ACTIONS },
      // Cosine gate dropped to -1 so the rerank path WOULD be active
      // if the gate didn't skip it pre-RAG.
      { minCosineForRerank: -1 },
    );

    expect(result.strategy).toBe('no-match');
    if (result.strategy === 'no-match') {
      expect(result.reason).toMatch(/no-match: contract supplied/);
    }
    // Load-bearing: judge MUST NOT have been called. The gate
    // short-circuits before RAG retrieval, before rerank, before
    // any LLM cost.
    expect(judgeCalled).toBe(false);
  });

  it('still hits match-exact on canonical-key equality (gate does not block exact match)', async () => {
    const registry = makeRegistry();
    const stored = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: COUNTER_THREE_ACTIONS,
      intent: 'three-action counter',
      componentCode: 'export default () => <div/>;',
    });
    const result = await matchBlueprint({ registry }, SCOPE, {
      intent: 'paraphrased — same contract',
      contract: COUNTER_THREE_ACTIONS,
    });
    expect(result.strategy).toBe('exact-key');
    if (result.strategy === 'exact-key') {
      expect(result.blueprint.id).toBe(stored.id);
    }
  });

  it('contract-LESS request still flows through the judge (semantic strategy active)', async () => {
    // The semantic strategy's value remains for contract-less
    // requests — agent didn't commit to specific wire details, so
    // serving a similar cached blueprint is structurally safe (the
    // matched blueprint's contract becomes the negotiated contract).
    const registry = makeRegistry();
    const stored = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: COUNTER_TWO_ACTIONS,
      intent: 'a counter',
      componentCode: 'export default () => <div/>;',
    });
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm({
          matchId: stored.id,
          confidence: 0.9,
          reason: 'matches contract-less counter ask',
        }),
      },
      SCOPE,
      { intent: 'a counter widget' }, // ← no contract supplied
      { minCosineForRerank: -1 },
    );
    expect(result.strategy).toBe('semantic');
  });
});
