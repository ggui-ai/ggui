import { describe, it, expect } from 'vitest';
import {
  generateReport,
  toDisplayReport,
} from '@ggui-ai/benchmark/multi-sdk/reporter';
import {
  AESTHETIC_JUDGE_MODEL,
  AESTHETIC_PROMPT_VERSION,
  type PostEvalResult,
} from '@ggui-ai/benchmark/multi-sdk/post-eval';
import type {
  BenchmarkCommit,
  BenchmarkRunResult,
  BenchmarkVariant,
} from '@ggui-ai/benchmark/multi-sdk/types';
import { readEvalScore, readDimensions, readJudge } from './eval-helpers';

describe('readEvalScore', () => {
  it('returns score when present and numeric', () => {
    expect(readEvalScore({ score: 88, dimensions: {} })).toBe(88);
    expect(readEvalScore({ score: 0 })).toBe(0);
  });

  it('returns null for null/undefined evaluation', () => {
    expect(readEvalScore(null)).toBe(null);
    expect(readEvalScore(undefined)).toBe(null);
  });

  it('returns null when score is missing', () => {
    expect(readEvalScore({ finalScore: 88 })).toBe(null); // runner-internal alias, never on the wire
    expect(readEvalScore({})).toBe(null);
  });

  it('returns null when score is non-numeric', () => {
    expect(readEvalScore({ score: '88' })).toBe(null);
    expect(readEvalScore({ score: null })).toBe(null);
  });

  it('returns null for primitives', () => {
    expect(readEvalScore('not an object')).toBe(null);
    expect(readEvalScore(42)).toBe(null);
  });
});

describe('readDimensions', () => {
  const valid = {
    layout: 90,
    designTokens: 85,
    hierarchy: 88,
    polish: 92,
    dataPresentation: 87,
  };

  it('returns the 5 measured dimensions when all present', () => {
    expect(readDimensions({ dimensions: valid })).toEqual(valid);
  });

  it('strips extra properties', () => {
    const withExtra = { ...valid, intent: 'extra', extraneous: 99 };
    const result = readDimensions({ dimensions: withExtra });
    expect(result).toEqual(valid);
    expect(result).not.toHaveProperty('intent');
  });

  it('returns null when any dimension is missing', () => {
    const { dataPresentation, ...incomplete } = valid;
    void dataPresentation;
    expect(readDimensions({ dimensions: incomplete })).toBe(null);
  });

  it('returns null when any dimension is non-numeric', () => {
    expect(
      readDimensions({ dimensions: { ...valid, layout: 'high' } }),
    ).toBe(null);
  });

  it('returns null for the retired synthesized-dimension shape', () => {
    // The pre-truth-fix shape fabricated completeness/visualPolish/…
    // from the measured five; the viewer must NOT read it as valid.
    expect(
      readDimensions({
        dimensions: {
          completeness: 90,
          visualPolish: 85,
          interactivity: 88,
          accessibility: 92,
          codeQuality: 87,
        },
      }),
    ).toBe(null);
  });

  it('returns null for missing dimensions field', () => {
    expect(readDimensions({ dimensionScores: valid })).toBe(null);
    expect(readDimensions({})).toBe(null);
    expect(readDimensions(null)).toBe(null);
  });
});

describe('readJudge', () => {
  it('returns the judge disclosure when present', () => {
    expect(
      readJudge({ judge: { model: 'claude-haiku-4-5-20251001', promptVersion: 'aesthetic-eval.v1' } }),
    ).toEqual({ model: 'claude-haiku-4-5-20251001', promptVersion: 'aesthetic-eval.v1' });
  });

  it('returns null when judge is absent or malformed', () => {
    expect(readJudge({})).toBe(null);
    expect(readJudge({ judge: { model: 'x' } })).toBe(null);
    expect(readJudge(null)).toBe(null);
  });
});

// ─── Round-trip: real reporter output → viewer accessors ───────────
//
// Drives the ACTUAL runner serialization path (generateReport →
// toDisplayReport) with a synthetic result, then reads the emitted
// evaluation through the viewer helpers. This is the fixture test that
// was missing when the viewer read `finalScore` while the runner wrote
// `score` — hand-built fixtures on both sides masked the drift.

function mkRunResult(overrides: Partial<BenchmarkRunResult> = {}): BenchmarkRunResult {
  const variant: BenchmarkVariant = {
    id: 'claude-fast',
    sdkName: 'claude',
    tier: 'fast',
    modelId: 'anthropic/claude-haiku-4-5',
  };
  const commit: BenchmarkCommit = {
    id: 'weather-card',
    name: 'Weather Card',
    description: '',
    complexity: 'simple',
    prompt: 'Build a weather card.',
    contract: { intent: 'test' } as BenchmarkCommit['contract'],
  };
  const evaluation: PostEvalResult = {
    passed: true,
    score: 86.4,
    dimensions: {
      layout: 90,
      designTokens: 82,
      hierarchy: 88,
      polish: 84,
      dataPresentation: 88,
    },
    judge: {
      model: AESTHETIC_JUDGE_MODEL,
      promptVersion: AESTHETIC_PROMPT_VERSION,
    },
    issues: [],
    critique: 'Solid layout; minor token gaps.',
    evalTimeMs: 1430,
  };
  return {
    variant,
    commit,
    generation: {
      compiledCode: 'export default function C(){}',
      sourceCode: 'export default function C(){}',
      tokens: { input: 100, output: 50, total: 150 },
      generationTimeMs: 12000,
      turnsUsed: 3,
    },
    evaluation,
    estimatedCostUsd: 0.01,
    timestamp: '2026-06-11T00:00:00Z',
    generator: 'ui-gen-default-haiku-4-5',
    ...overrides,
  };
}

describe('round-trip: toDisplayReport → eval-helpers', () => {
  it('reads the score, dimensions, and judge the reporter actually emits', () => {
    const report = generateReport([mkRunResult()], 12345);
    const display = toDisplayReport(report, 'rt-report', 'test');

    // Serialize + parse — exactly what the dashboard consumes off disk.
    const onDisk = JSON.parse(JSON.stringify(display)) as typeof display;
    const evaluation = onDisk.results[0]!.evaluation;

    expect(readEvalScore(evaluation)).toBe(86.4);
    expect(readDimensions(evaluation)).toEqual({
      layout: 90,
      designTokens: 82,
      hierarchy: 88,
      polish: 84,
      dataPresentation: 88,
    });
    expect(readJudge(evaluation)).toEqual({
      model: AESTHETIC_JUDGE_MODEL,
      promptVersion: AESTHETIC_PROMPT_VERSION,
    });
    // Meta carries the same judge disclosure.
    expect(onDisk.meta.judge).toEqual({
      model: AESTHETIC_JUDGE_MODEL,
      promptVersion: AESTHETIC_PROMPT_VERSION,
    });
  });

  it('a result without evaluation yields null score (rendered as "—", never "pass")', () => {
    const report = generateReport(
      [mkRunResult({ evaluation: null })],
      12345,
    );
    const display = toDisplayReport(report, 'rt-report-2', 'test');
    const onDisk = JSON.parse(JSON.stringify(display)) as typeof display;

    expect(onDisk.results[0]!.evaluation).toBeNull();
    expect(readEvalScore(onDisk.results[0]!.evaluation)).toBe(null);
    expect(onDisk.meta.judge).toBeUndefined();
  });
});
