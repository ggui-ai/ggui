import { describe, it, expect } from 'vitest';
import {
  aggregatePanel,
  type SingleJudgeResult,
  type AestheticScores,
} from './post-eval.js';

/** Build a SingleJudgeResult with the given score + (optionally) per-dim scores. */
function judge(score: number, dims?: Partial<AestheticScores>): SingleJudgeResult {
  const dimensions: AestheticScores = {
    layout: score,
    designTokens: score,
    hierarchy: score,
    polish: score,
    dataPresentation: score,
    ...dims,
  };
  return {
    judge: { model: 'test', promptVersion: 'aesthetic-eval.v2-panel' },
    score,
    dimensions,
    critique: `critique@${score}`,
    tokens: { input: 100, output: 50 },
  };
}

describe('aggregatePanel', () => {
  it('averages 3 judges (80/70/90 → score 80, spread 20)', () => {
    const result = aggregatePanel([judge(80), judge(70), judge(90)]);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(80);
    expect(result?.spread).toBe(20);
  });

  it('averages per-dimension independently (layout 60/70/80 → 70)', () => {
    const result = aggregatePanel([
      judge(75, { layout: 60 }),
      judge(75, { layout: 70 }),
      judge(75, { layout: 80 }),
    ]);
    expect(result).not.toBeNull();
    expect(result?.dimensions.layout).toBe(70);
    // The other dims are all 75 across judges → mean stays 75.
    expect(result?.dimensions.designTokens).toBe(75);
    expect(result?.dimensions.hierarchy).toBe(75);
    expect(result?.dimensions.polish).toBe(75);
    expect(result?.dimensions.dataPresentation).toBe(75);
  });

  it('rounds means to 1 decimal place', () => {
    // 70/71/73 → mean 71.333… → 71.3
    const result = aggregatePanel([judge(70), judge(71), judge(73)]);
    expect(result?.score).toBe(71.3);
  });

  it('returns null for a 1-judge "panel"', () => {
    expect(aggregatePanel([judge(85)])).toBeNull();
  });

  it('returns null for 0 judges', () => {
    expect(aggregatePanel([])).toBeNull();
  });

  it('aggregates a valid 2-judge panel (80/90 → score 85, spread 10)', () => {
    const result = aggregatePanel([judge(80), judge(90)]);
    expect(result).not.toBeNull();
    expect(result?.score).toBe(85);
    expect(result?.spread).toBe(10);
  });
});
