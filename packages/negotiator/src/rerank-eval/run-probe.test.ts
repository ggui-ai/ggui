/**
 * Validates the probe harness with a stub LLM. Real-LLM evaluation
 * runs via the CLI (`run-probe-cli.ts`) and is excluded from CI.
 */
import { describe, it, expect } from 'vitest';
import { runProbe, formatReport } from './run-probe.js';
import { EVAL_PAIRS } from './pairs.js';
import type { LLMCaller, ToolSchema } from '../llm-caller.js';

/**
 * Stub that always returns the gold-standard answer for the queried
 * pair. Demonstrates the harness aggregates correctly when the
 * "model" is perfect.
 */
function oracleStubLlm(): LLMCaller {
  return {
    async call() {
      throw new Error('text-mode not used');
    },
    async callStructured<T>(
      _systemPrompt: string,
      userMessage: string,
      _tool: ToolSchema,
    ): Promise<T> {
      // The harness builds userMessage with `id: <pair.id>` for the
      // current request — but actually the message has ids for the
      // CANDIDATES, not the pair. We need to identify the pair some
      // other way. Use the intent prefix to look up the pair.
      const intentMatch = userMessage.match(/intent: ([^\n]+)/);
      const intent = intentMatch?.[1] ?? '';
      const pair = EVAL_PAIRS.find((p) => p.query.intent === intent);
      if (!pair) {
        throw new Error(`oracle stub: no eval pair matched intent "${intent}"`);
      }
      const result = {
        matchId: pair.goldMatchId,
        confidence: pair.goldMatchId === null ? 0.1 : 0.95,
        reason: 'oracle stub — returns gold',
      };
      return result as unknown as T;
    },
  };
}

/**
 * Stub that ALWAYS predicts the highest-cosine candidate at high
 * confidence — simulates a naive cosine-only matcher (the today
 * baseline before LLM rerank). Should fail on adversarial pairs
 * because top-cosine candidates ARE the adversarial fake-matches.
 */
function topCosineStubLlm(): LLMCaller {
  return {
    async call() {
      throw new Error('text-mode not used');
    },
    async callStructured<T>(
      _systemPrompt: string,
      userMessage: string,
      _tool: ToolSchema,
    ): Promise<T> {
      // Parse out the candidate ids in order; the eval pairs already
      // sort by descending cosine, so id[0] is top-cosine.
      const ids = [...userMessage.matchAll(/^ {2}id: ([^\n]+)/gm)].map(
        (m) => m[1]!,
      );
      const result = {
        matchId: ids[0] ?? null,
        confidence: 0.9,
        reason: 'top-cosine stub — always picks first',
      };
      return result as unknown as T;
    },
  };
}

describe('runProbe harness', () => {
  it('reports 100% precision when LLM is the gold oracle', async () => {
    const report = await runProbe({ llm: oracleStubLlm() });
    expect(report.totals.correct).toBe(report.totals.all);
    expect(report.totals.precision).toBe(1);
    expect(report.adversarialFalsePositiveRate).toBe(0);
  });

  it('catches adversarial false-positives when LLM is naive top-cosine', async () => {
    const report = await runProbe({ llm: topCosineStubLlm() });
    // Top-cosine on adversarial pairs picks the structurally-similar
    // but intent-divergent candidate — gold is null, predicted is
    // non-null → adversarial FP rate should be HIGH.
    expect(report.adversarialFalsePositiveRate).toBeGreaterThan(0.5);
    // Overall precision drops well below the G1 threshold.
    expect(report.totals.precision).toBeLessThan(0.85);
  });

  it('respects the threshold gate — confidence below threshold = no-match', async () => {
    // Stub returns the gold but at confidence 0.5; with default
    // threshold=0.6, all should-match predictions collapse to null.
    const lowConfStub: LLMCaller = {
      async call() {
        return '';
      },
      async callStructured<T>(
        _system: string,
        userMessage: string,
        _tool: ToolSchema,
      ): Promise<T> {
        const intentMatch = userMessage.match(/intent: ([^\n]+)/);
        const intent = intentMatch?.[1] ?? '';
        const pair = EVAL_PAIRS.find((p) => p.query.intent === intent);
        return {
          matchId: pair?.goldMatchId ?? null,
          confidence: 0.5,
          reason: 'low conf',
        } as unknown as T;
      },
    };
    const report = await runProbe({ llm: lowConfStub });
    // Should-match pairs become wrong (predicted null, gold non-null).
    expect(report.byKind['should-match'].correct).toBeLessThan(
      report.byKind['should-match'].all,
    );
    // No-match pairs stay correct (predicted null, gold null).
    expect(report.byKind['no-match'].correct).toBe(
      report.byKind['no-match'].all,
    );
  });

  it('limit option subsets the run', async () => {
    const report = await runProbe({ llm: oracleStubLlm() }, { limit: 5 });
    expect(report.totals.all).toBe(5);
  });

  it('formatReport produces gate lines', async () => {
    const report = await runProbe({ llm: oracleStubLlm() });
    const text = formatReport(report);
    expect(text).toContain('G1 precision@1');
    expect(text).toContain('G2 adversarial FP');
    expect(text).toContain('G3 latency');
  });
});
