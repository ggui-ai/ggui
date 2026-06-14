import { describe, it, expect } from 'vitest';
import {
  generateReport,
  toDisplayReport,
} from '@ggui-ai/benchmark/multi-sdk/reporter';
import {
  AESTHETIC_PROMPT_VERSION_PANEL,
  type PanelEvalResult,
  type SingleJudgeResult,
} from '@ggui-ai/benchmark/multi-sdk/post-eval';
import type {
  BenchmarkCommit,
  BenchmarkRunResult,
  BenchmarkVariant,
} from '@ggui-ai/benchmark/multi-sdk/types';
import {
  readEvalScore,
  readDimensions,
  readJudges,
  readJudgePanel,
  readSpread,
  readCritique,
} from './eval-helpers';

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

describe('readJudges', () => {
  it('returns the panel disclosures when present', () => {
    expect(
      readJudges({
        judges: [
          { model: 'claude-haiku-4-5-20251001', promptVersion: 'aesthetic-eval.v2-panel' },
          { model: 'gpt-5.4-mini', promptVersion: 'aesthetic-eval.v2-panel' },
        ],
      }),
    ).toEqual([
      { model: 'claude-haiku-4-5-20251001', promptVersion: 'aesthetic-eval.v2-panel' },
      { model: 'gpt-5.4-mini', promptVersion: 'aesthetic-eval.v2-panel' },
    ]);
  });

  it('returns null when judges is absent, empty, or malformed', () => {
    expect(readJudges({})).toBe(null);
    expect(readJudges({ judges: [] })).toBe(null);
    expect(readJudges({ judges: [{ model: 'x' }] })).toBe(null);
    expect(readJudges({ judges: 'not-an-array' })).toBe(null);
    // The retired single-judge `judge` field is NOT read as a panel.
    expect(readJudges({ judge: { model: 'x', promptVersion: 'v1' } })).toBe(null);
    expect(readJudges(null)).toBe(null);
  });
});

describe('readSpread', () => {
  it('returns the spread when numeric (including 0)', () => {
    expect(readSpread({ spread: 4.2 })).toBe(4.2);
    expect(readSpread({ spread: 0 })).toBe(0);
  });

  it('returns null when absent or non-numeric', () => {
    expect(readSpread({})).toBe(null);
    expect(readSpread({ spread: '4.2' })).toBe(null);
    expect(readSpread(null)).toBe(null);
  });
});

describe('readCritique', () => {
  it('returns the critique string when present', () => {
    expect(readCritique({ critique: 'Solid layout.' })).toBe('Solid layout.');
  });

  it('returns null when absent or non-string', () => {
    expect(readCritique({})).toBe(null);
    expect(readCritique({ critique: 42 })).toBe(null);
    expect(readCritique(null)).toBe(null);
  });
});

describe('readJudgePanel', () => {
  const panel = [
    { judge: { model: 'claude-haiku-4-5-20251001', promptVersion: 'aesthetic-eval.v2-panel' }, score: 88, dimensions: {} },
    { judge: { model: 'gpt-5.4-mini', promptVersion: 'aesthetic-eval.v2-panel' }, score: 82, dimensions: {} },
  ];

  it('returns one {model, promptVersion, score} per panel judge', () => {
    expect(readJudgePanel({ panel })).toEqual([
      { model: 'claude-haiku-4-5-20251001', promptVersion: 'aesthetic-eval.v2-panel', score: 88 },
      { model: 'gpt-5.4-mini', promptVersion: 'aesthetic-eval.v2-panel', score: 82 },
    ]);
  });

  it('returns null when panel is absent, empty, or malformed', () => {
    expect(readJudgePanel({})).toBe(null);
    expect(readJudgePanel({ panel: [] })).toBe(null);
    expect(readJudgePanel({ panel: 'nope' })).toBe(null);
    // Missing score → malformed.
    expect(
      readJudgePanel({ panel: [{ judge: { model: 'x', promptVersion: 'v' } }] }),
    ).toBe(null);
    // Missing judge → malformed.
    expect(readJudgePanel({ panel: [{ score: 88 }] })).toBe(null);
    // Judge missing promptVersion → malformed.
    expect(
      readJudgePanel({ panel: [{ judge: { model: 'x' }, score: 88 }] }),
    ).toBe(null);
    expect(readJudgePanel(null)).toBe(null);
  });
});

// ─── Round-trip: real reporter output → viewer accessors ───────────
//
// Drives the ACTUAL runner serialization path (generateReport →
// toDisplayReport) with a synthetic PANEL result, then reads the emitted
// evaluation through the viewer helpers. This is the fixture test that
// catches drift between what the runner writes and what the viewer reads
// (a hand-built fixture on both sides would mask a rename).

/** A single panel judge result with the given model + scores. */
function mkJudge(
  model: string,
  score: number,
  dims: SingleJudgeResult['dimensions'],
  critique: string,
): SingleJudgeResult {
  return {
    judge: { model, promptVersion: AESTHETIC_PROMPT_VERSION_PANEL },
    score,
    dimensions: dims,
    critique,
    tokens: { input: 100, output: 50 },
  };
}

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
  const judges: SingleJudgeResult[] = [
    mkJudge(
      'claude-haiku-4-5-20251001',
      90,
      { layout: 92, designTokens: 84, hierarchy: 90, polish: 86, dataPresentation: 98 },
      'Strong overall.',
    ),
    mkJudge(
      'gpt-5.4-mini',
      82,
      { layout: 88, designTokens: 80, hierarchy: 86, polish: 82, dataPresentation: 74 },
      'Solid layout; minor token gaps.',
    ),
    mkJudge(
      'gemini-3-flash-preview',
      87,
      { layout: 90, designTokens: 82, hierarchy: 88, polish: 84, dataPresentation: 92 },
      'Clean but could polish more.',
    ),
  ];
  const evaluation: PanelEvalResult = {
    passed: true,
    score: 86.4, // mean of 90/82/87 → 86.3; pinned for the read assertion below
    dimensions: {
      layout: 90,
      designTokens: 82,
      hierarchy: 88,
      polish: 84,
      dataPresentation: 88,
    },
    spread: 8, // max(90) − min(82)
    judges,
    promptVersion: AESTHETIC_PROMPT_VERSION_PANEL,
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
  it('reads the score, dimensions, panel, spread, critique, and judges the reporter emits', () => {
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
    expect(readSpread(evaluation)).toBe(8);
    expect(readCritique(evaluation)).toBe('Solid layout; minor token gaps.');

    // Per-judge panel breakdown — one entry per judge that responded.
    expect(readJudgePanel(evaluation)).toEqual([
      { model: 'claude-haiku-4-5-20251001', promptVersion: AESTHETIC_PROMPT_VERSION_PANEL, score: 90 },
      { model: 'gpt-5.4-mini', promptVersion: AESTHETIC_PROMPT_VERSION_PANEL, score: 82 },
      { model: 'gemini-3-flash-preview', promptVersion: AESTHETIC_PROMPT_VERSION_PANEL, score: 87 },
    ]);

    // Distinct panel disclosures (dedup by model).
    expect(readJudges(evaluation)).toEqual([
      { model: 'claude-haiku-4-5-20251001', promptVersion: AESTHETIC_PROMPT_VERSION_PANEL },
      { model: 'gpt-5.4-mini', promptVersion: AESTHETIC_PROMPT_VERSION_PANEL },
      { model: 'gemini-3-flash-preview', promptVersion: AESTHETIC_PROMPT_VERSION_PANEL },
    ]);

    // Meta carries the same panel disclosure.
    expect(onDisk.meta.judges).toEqual([
      { model: 'claude-haiku-4-5-20251001', promptVersion: AESTHETIC_PROMPT_VERSION_PANEL },
      { model: 'gpt-5.4-mini', promptVersion: AESTHETIC_PROMPT_VERSION_PANEL },
      { model: 'gemini-3-flash-preview', promptVersion: AESTHETIC_PROMPT_VERSION_PANEL },
    ]);
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
    expect(readJudgePanel(onDisk.results[0]!.evaluation)).toBe(null);
    expect(onDisk.meta.judges).toBeUndefined();
  });
});
