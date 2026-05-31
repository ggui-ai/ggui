import { describe, it, expect, afterEach } from 'vitest';
import {
  InMemoryBlueprintIndex,
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

// Two contracts for the SAME intent that differ exactly the way the LLM
// authors a todo UI run-to-run (the cache-key-probe finding): different
// action LABELS + a different toggle payload schema (`id` vs `id+done`).
// They produce DIFFERENT blueprintKeys → an exact-key probe MISSES, even
// though they answer the same need. This is the case the contract-bearing
// semantic fall-through must bridge.
const TODO_CONTRACT_CACHED: DataContract = {
  propsSpec: {
    properties: { todos: { required: true, schema: { type: 'array' } } },
  },
  actionSpec: {
    addTodo: { label: 'Add todo item' },
    toggleTodo: {
      label: 'Toggle',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
};
const TODO_CONTRACT_AGENT: DataContract = {
  propsSpec: {
    properties: { todos: { required: true, schema: { type: 'array' } } },
  },
  actionSpec: {
    addTodo: { label: 'Add a new todo item' },
    toggleTodo: {
      label: "Toggle a todo's done state",
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, done: { type: 'boolean' } },
        required: ['id', 'done'],
      },
    },
  },
};

function makeRegistry() {
  return {
    embedding: new MockEmbeddingProvider(),
    vectorStore: new InMemoryVectorStore(),
    index: new InMemoryBlueprintIndex(),
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
    const registered = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm({
          // Judge picks the candidate by its opaque registry id.
          matchId: registered.id,
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
    const registered = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm({
          matchId: registered.id,
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
  it('contract-bearing + canonical-key absent + empty scope → no-match (falls through to semantic, no candidate)', async () => {
    // Contract supplied + canonical-key lookup misses → exact-key
    // fast-path misses and falls through to the semantic strategy, which
    // finds no candidates in the empty scope → no-match. (With a covering
    // candidate present this would instead reuse via the judge.)
    const registry = makeRegistry();
    const result = await matchBlueprint(
      { registry, llm: stubLlm({ matchId: null, confidence: 0, reason: '' }) },
      SCOPE,
      { intent: 'something', contract: NOTEPAD_CONTRACT },
    );
    expect(result.strategy).toBe('no-match');
    if (result.strategy === 'no-match') {
      expect(result.candidates).toEqual([]);
      expect(result.reason).toMatch(/no candidates in scope/);
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

  it('emits no-match (semantic strategy) when contract supplied + canonical-key absent + empty scope', async () => {
    // Contract supplied → exact-key fast-path misses and falls through
    // to the semantic strategy, which finds no candidates in the empty
    // scope → no-match emitted under the semantic strategy.
    setCacheTraceSink(captureSink());
    const registry = makeRegistry();
    await matchBlueprint({ registry }, SCOPE, {
      intent: 'something',
      contract: NOTEPAD_CONTRACT,
    });
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.decision).toBe('no-match');
    expect(ev.strategy).toBe('semantic');
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

describe('matchBlueprint — coverage is informational (Path A)', () => {
  // Path A (Phase 2 Wave 2C): the matcher PROPOSES a similar cached
  // blueprint to a contract-bearing request even when it does NOT cover
  // every declared surface. There is NO coverage hard-drop and NO coverage
  // floor — only the cosine (0.3) + judge (0.6) gates remain. A subset
  // blueprint (missing an action / field the request declares) is reused
  // and the gap is REPORTED on `hit.coverage` so the decision layer can
  // surface COVERAGE_GAP warn findings; the agent override is the safety
  // valve. This is the 2026-05-09 case (request {increment, decrement,
  // reset} matched a 2-action {increment, reset} cached blueprint) — now
  // handled by proposing + reporting the gap, not by refusing to match.

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

  it('PROPOSES a subset cached blueprint to a contract-bearing request, reporting the coverage gap on the hit', async () => {
    // Setup: register the 2-action counter, then request a 3-action
    // counter. The judge runs (NO coverage hard-drop) and accepts the
    // similar shape; the matcher returns a semantic hit whose
    // `coverage.actions` names the missing `decrement` so the decision
    // layer can warn. Agent override is the safety valve.
    const registry = makeRegistry();
    const stored = await registerBlueprint(registry, SCOPE, {
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
          judgeCalled = true;
          return {
            matchId: stored.id,
            confidence: 0.95,
            reason: 'similar counter shape',
          };
        }),
      },
      SCOPE,
      { intent: 'a counter widget', contract: COUNTER_THREE_ACTIONS },
      // Cosine gate dropped to -1 so the rerank path is active.
      { minCosineForRerank: -1 },
    );

    expect(result.strategy).toBe('semantic');
    if (result.strategy === 'semantic') {
      // Reuses the CACHED 2-action blueprint (its contract + UI).
      expect(result.blueprint.id).toBe(stored.id);
      // The coverage gap names the missing `decrement` action — surfaced
      // on the hit for the decision layer's COVERAGE_GAP warn findings.
      expect(result.coverage.actions).toEqual(['decrement']);
      // The reason string carries the coverage-gap note for trace logs.
      expect(result.reason).toMatch(/coverage gap/);
    }
    // The judge DID run — there is no coverage hard-drop before it.
    expect(judgeCalled).toBe(true);
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
    if (result.strategy === 'semantic') {
      // Contract-less → nothing to cover against → empty gap.
      expect(result.coverage.actions).toEqual([]);
      expect(result.coverage.props).toEqual([]);
      expect(result.coverage.context).toEqual([]);
      expect(result.coverage.streams).toEqual([]);
      expect(result.coverage.gadgets).toEqual([]);
    }
  });

  it('reports an EMPTY coverage gap (no note) when the cached blueprint fully covers the request', async () => {
    // The cached 3-action counter covers a 2-action subset request, so the
    // semantic hit's coverage gap is empty and the reason carries no note.
    const registry = makeRegistry();
    const stored = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: COUNTER_THREE_ACTIONS,
      intent: 'a counter widget',
      componentCode: 'export default () => <div/>;',
    });
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm({
          matchId: stored.id,
          confidence: 0.95,
          reason: 'superset counter covers the request',
        }),
      },
      SCOPE,
      { intent: 'a counter widget', contract: COUNTER_TWO_ACTIONS },
      { minCosineForRerank: -1 },
    );
    expect(result.strategy).toBe('semantic');
    if (result.strategy === 'semantic') {
      expect(result.blueprint.id).toBe(stored.id);
      expect(result.coverage.actions).toEqual([]);
      expect(result.reason).not.toMatch(/coverage gap/);
    }
  });
});

// ─── Phase 1 TARGET: contract-bearing semantic fall-through ──────────────
// These pin the behavior we are BUILDING: when the agent supplies a
// contract (as the handshake always does) and it does NOT canonical-key
// match, the matcher must fall through from exact-key into the existing
// semantic find+judge and reuse a similar cached blueprint — returning the
// CACHED contract+UI atomically, never the agent's draft under cached code.
//
// The first test is RED today (exact-key miss currently hard-returns
// no-match; blueprint-matcher.ts:263-307) and turns GREEN once Phase 1
// lifts the gate. The second pins that the free exact-key fast-path still
// wins when the agent reproduces the cached contract (no judge call).
describe('matchBlueprint — contract-bearing semantic fall-through (Phase 1)', () => {
  const NO_COSINE_GATE = { minCosineForRerank: -1 };

  it('reuses a similar cached blueprint when the agent submits a DIFFERENT contract for the same intent', async () => {
    const registry = makeRegistry();
    const stored = await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: TODO_CONTRACT_CACHED,
      intent: 'my todo items',
      componentCode: 'export default () => null;',
    });

    // Agent re-authored an equivalent-but-not-identical contract (LLM
    // noise) → exact-key MISSES. Find-similar + judge should still reuse.
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm({
          matchId: stored.id,
          confidence: 0.9,
          reason: 'same todo UI, paraphrased contract',
        }),
      },
      SCOPE,
      { intent: 'my todo items', contract: TODO_CONTRACT_AGENT },
      NO_COSINE_GATE,
    );

    expect(result.strategy).toBe('semantic');
    if (result.strategy === 'semantic') {
      // Reuses the CACHED blueprint (its contract + UI), NOT the agent's draft.
      expect(result.blueprint.contractKey).toBe(
        blueprintKey(TODO_CONTRACT_CACHED),
      );
      expect(result.blueprint.intent).toBe('my todo items');
    }
  });

  it('still takes the free exact-key fast-path (no judge call) when the agent reproduces the cached contract', async () => {
    const registry = makeRegistry();
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: TODO_CONTRACT_CACHED,
      intent: 'my todo items',
      componentCode: 'x',
    });
    let judgeCalled = false;
    const result = await matchBlueprint(
      {
        registry,
        llm: stubLlm(() => {
          judgeCalled = true;
          return { matchId: null, confidence: 0, reason: 'unused' };
        }),
      },
      SCOPE,
      { intent: 'my todo items', contract: TODO_CONTRACT_CACHED },
      NO_COSINE_GATE,
    );
    expect(result.strategy).toBe('exact-key');
    expect(judgeCalled).toBe(false); // exact-key short-circuits before the LLM
  });
});
