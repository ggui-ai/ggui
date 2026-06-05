import { describe, it, expect } from 'vitest';
import {
  rerankCandidates,
  RERANK_SYSTEM_PROMPT,
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
      return value as T;
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

describe('RERANK_SYSTEM_PROMPT — similarity-only judge (no field-coverage gate)', () => {
  const prompt = RERANK_SYSTEM_PROMPT;
  const lower = prompt.toLowerCase();

  it('(a) does NOT require the candidate to have the same wire surface (slot/action names)', () => {
    // The load-bearing flaw: the old MATCH clause demanded "same wire
    // surface (slot names, action names)", silently re-imposing a
    // field-coverage gate the architecture deliberately removed.
    expect(lower).not.toContain('same wire surface');
    expect(lower).not.toMatch(/same\s+(?:slot|action)\s+names/);
  });

  it('(b) states added/omitted fields are REPORTED to the agent, not declined', () => {
    // Adding or omitting fields/slots/actions must not block a match;
    // those deltas are reported to the agent separately.
    expect(lower).toMatch(/add(?:s|ed|ing)?\b[\s\S]*\bomit/);
    expect(lower).toMatch(/do not block|does not block|not\s+a\s+blocker|do not gate/);
    expect(lower).toMatch(/report(?:ed)?\s+to\s+the\s+agent/);
  });

  it('(c) keys MATCH on same intended task + same broad UI shape', () => {
    expect(lower).toMatch(/same (?:intended )?(?:user )?task/);
    expect(lower).toMatch(/same (?:broad )?ui shape|component types|layout pattern/);
  });

  it('(c) reserves NO-MATCH for different task / different UI shape / conflicting fixed VALUES', () => {
    expect(lower).toContain('no-match');
    expect(lower).toMatch(/different (?:intended )?task/);
    expect(lower).toMatch(/different ui shape/);
    // Conflicting fixed values: the calendar-Jan vs calendar-Mar case.
    expect(lower).toMatch(/conflict/);
    expect(lower).toMatch(/value/);
    expect(prompt).toMatch(/calendar-Jan|Jan.*Mar|fixed value/i);
  });

  it('does NOT list added/omitted fields or a differing wire surface as a NO-MATCH trigger', () => {
    // Slice the NO-MATCH region (from the NO-MATCH *definition* up to
    // the visual-style clause) and ensure field/wire deltas are not
    // named there. Anchor on "NO-MATCH means" rather than a bare
    // "NO-MATCH" so the slice never silently swallows MATCH-paragraph
    // text if the word "NO-MATCH" later appears earlier in the prompt.
    const noMatchStart = prompt.search(/^NO-MATCH means/m);
    expect(noMatchStart).toBeGreaterThanOrEqual(0);
    const visualClauseStart = prompt.search(/[Vv]isual style/);
    expect(visualClauseStart).toBeGreaterThan(noMatchStart);
    const noMatchRegion = prompt.slice(noMatchStart, visualClauseStart).toLowerCase();
    expect(noMatchRegion).not.toContain('wire surface');
    expect(noMatchRegion).not.toMatch(/added|omitted|missing field|extra field/);
  });

  it('keeps the visual-style clause and the final tool-call output sentence', () => {
    expect(lower).toContain('visual style');
    expect(lower).toMatch(/do not block a match/);
    expect(lower).toMatch(/output exactly one tool call/);
    expect(lower).toMatch(/confidence is a number in \[0, 1\]/);
  });

  it('frames a superset-but-same-task candidate as MATCH-eligible (judges on similarity, not coverage)', () => {
    // A candidate that omits a field the current request adds (an
    // optional superset of the cached contract) must be eligible to
    // MATCH. We assert the judge, stubbed to pick it, is passed through
    // — i.e. the harness imposes no coverage gate of its own — and that
    // the prompt's own wording permits this framing.
    const supersetQuery: RerankQuery = {
      intent: 'Weather card showing city name and temperature',
      contractSummary: 'slots=cityName,tempC; actions=∅; streams=∅',
    };
    const supersetCandidates: readonly RerankCandidate[] = [
      {
        id: 'bp-weather-cityonly',
        cachedIntent: 'Weather card showing the city name',
        // Cached contract OMITS tempC — the current request is a superset.
        cachedContractSummary: 'slots=cityName; actions=∅; streams=∅',
        cosine: 0.94,
      },
    ];
    // Prompt wording must permit a superset to match.
    expect(lower).toMatch(/superset|adds? (?:or omits?|fields|slots)|omits? (?:fields|slots|actions)/);
    // And the harness must pass the judge's MATCH through unmodified.
    return rerankCandidates(
      {
        llm: stubLlm({
          matchId: 'bp-weather-cityonly',
          confidence: 0.8,
          reason: 'same weather-card task; current request just adds tempC',
        }),
      },
      supersetQuery,
      supersetCandidates,
    ).then((decision) => {
      expect(decision.matchId).toBe('bp-weather-cityonly');
      expect(decision.confidence).toBeCloseTo(0.8);
    });
  });
});
