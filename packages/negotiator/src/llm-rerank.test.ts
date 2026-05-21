import { describe, it, expect } from 'vitest';
import {
  rerankCandidates,
  summarizeContract,
  type RerankCandidate,
  type RerankQuery,
} from './llm-rerank.js';
import type { LLMCaller, ToolSchema } from './llm-caller.js';

interface StubReturn {
  matchId: string | null;
  confidence: number;
  reason: string;
}

function stubLlm(
  ret: StubReturn | (() => StubReturn) | (() => Promise<StubReturn>),
): LLMCaller {
  return {
    async call() {
      throw new Error('text-mode not used by rerank');
    },
    async callStructured<T>(
      _systemPrompt: string,
      _userMessage: string,
      _tool: ToolSchema,
    ): Promise<T> {
      const value = typeof ret === 'function' ? await ret() : ret;
      return value as unknown as T;
    },
  };
}

const QUERY: RerankQuery = {
  intent: 'Build a notepad with a topic select',
  contractSummary:
    'slots=noteText,topic; actions=∅; streams=∅',
};

const CANDIDATES: readonly RerankCandidate[] = [
  {
    id: 'bp-notepad-1',
    cachedIntent: 'Live notepad panel with topic enum',
    cachedContractSummary:
      'slots=noteText,topic; actions=∅; streams=∅',
    cosine: 0.92,
  },
  {
    id: 'bp-feedback-1',
    cachedIntent: 'Feedback form with rating + comment',
    cachedContractSummary:
      'slots=∅; actions=submit; streams=∅; props=rating,comment',
    cosine: 0.41,
  },
];

describe('rerankCandidates', () => {
  it('returns no-match short-circuit on empty candidate list (no LLM call)', async () => {
    let called = false;
    const llm: LLMCaller = {
      async call() {
        called = true;
        return '';
      },
      async callStructured() {
        called = true;
        return {} as never;
      },
    };
    const decision = await rerankCandidates({ llm }, QUERY, []);
    expect(called).toBe(false);
    expect(decision.matchId).toBeNull();
    expect(decision.confidence).toBe(0);
    expect(decision.reason).toMatch(/short-circuited/);
  });

  it('returns the picked candidate id on a clean tool input', async () => {
    const llm = stubLlm({
      matchId: 'bp-notepad-1',
      confidence: 0.85,
      reason: 'identical contract surface, paraphrased intent',
    });
    const decision = await rerankCandidates({ llm }, QUERY, CANDIDATES);
    expect(decision.matchId).toBe('bp-notepad-1');
    expect(decision.confidence).toBeCloseTo(0.85);
    expect(decision.reason).toMatch(/paraphrased/);
  });

  it('returns null match when the judge picks no candidate', async () => {
    const llm = stubLlm({
      matchId: null,
      confidence: 0.3,
      reason: 'feedback form is unrelated; notepad has no candidate',
    });
    const decision = await rerankCandidates({ llm }, QUERY, CANDIDATES);
    expect(decision.matchId).toBeNull();
    expect(decision.confidence).toBe(0.3);
  });

  it('clamps out-of-range confidence to [0, 1]', async () => {
    const llm = stubLlm({
      matchId: 'bp-notepad-1',
      confidence: 2.5,
      reason: 'confidence too high',
    });
    const decision = await rerankCandidates({ llm }, QUERY, CANDIDATES);
    expect(decision.confidence).toBe(1);
  });

  it('treats invalid matchId (not in candidate set) as no-match', async () => {
    const llm = stubLlm({
      matchId: 'bp-not-in-set',
      confidence: 0.9,
      reason: 'judge hallucinated an id',
    });
    const decision = await rerankCandidates({ llm }, QUERY, CANDIDATES);
    expect(decision.matchId).toBeNull();
    expect(decision.confidence).toBe(0);
    expect(decision.reason).toMatch(/not in the candidate set/);
  });

  it('collapses LLM throw to null match + diagnostic reason', async () => {
    const llm = stubLlm(() => {
      throw new Error('upstream-503');
    });
    const decision = await rerankCandidates({ llm }, QUERY, CANDIDATES);
    expect(decision.matchId).toBeNull();
    expect(decision.confidence).toBe(0);
    expect(decision.reason).toMatch(/upstream-503/);
  });

  it('collapses non-object tool input to parse-failed reason', async () => {
    const llm = stubLlm(() => 'not-an-object' as unknown as StubReturn);
    const decision = await rerankCandidates({ llm }, QUERY, CANDIDATES);
    expect(decision.matchId).toBeNull();
    expect(decision.reason).toMatch(/parse-failed/);
  });

  it('reports llm-rerank-incompatible provider when callStructured absent', async () => {
    const llm: LLMCaller = {
      async call() {
        return '{"matchId":"bp-notepad-1","confidence":0.9,"reason":"text mode"}';
      },
    };
    const decision = await rerankCandidates({ llm }, QUERY, CANDIDATES);
    expect(decision.matchId).toBeNull();
    expect(decision.reason).toMatch(/does not support callStructured/);
  });

  it('records latency from start to finish', async () => {
    const llm = stubLlm(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { matchId: null, confidence: 0, reason: 'slow stub' };
    });
    const decision = await rerankCandidates({ llm }, QUERY, CANDIDATES);
    expect(decision.latencyMs).toBeGreaterThanOrEqual(10);
  });
});

describe('summarizeContract re-export', () => {
  // Full coverage lives in @ggui-ai/protocol's
  // registry/summarize-contract.test.ts. This is a smoke check that
  // negotiator's barrel still surfaces the same canonical function.
  it('reaches the protocol-side implementation through the barrel', () => {
    expect(summarizeContract({ contextSpec: { x: { schema: { type: 'string' } } } })).toMatch(
      /slots=x:string/,
    );
  });
});
