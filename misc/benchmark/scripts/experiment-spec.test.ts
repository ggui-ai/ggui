import { describe, it, expect } from 'vitest';
import {
  JUDGING_MARGIN,
  MAX_COST_CAP_USD,
  MAX_REPS,
  NIGHTLY_COMMITS,
  decideNextRep,
  parseExperimentSpec,
} from './experiment-spec.mjs';

const base = { id: 'exp-1743-stage2', variants: ['claude-balanced', 'claude-sonnet-5-5'], reps: 2, costCapUsd: 30 };

describe('parseExperimentSpec', () => {
  it('accepts a minimal spec and defaults the corpus to the nightly ten prompts', () => {
    const spec = parseExperimentSpec(base);
    expect(spec).toEqual({ ...base, commits: [...NIGHTLY_COMMITS] });
    expect(spec.commits).toHaveLength(10);
  });

  it('keeps an explicit corpus', () => {
    expect(parseExperimentSpec({ ...base, commits: ['survey-form'] }).commits).toEqual(['survey-form']);
  });

  it('names every problem at once, and rejects unknown fields rather than ignoring them', () => {
    expect(() =>
      parseExperimentSpec({ id: 'X', variants: [], reps: 0, costCapUsd: 0, model: 'anthropic/x' }),
    ).toThrow(/unknown field "model".*id must match.*variants must be a non-empty.*reps must be.*costCapUsd must be/);
  });

  it('bounds reps and the cap, so a typo cannot authorise a large run', () => {
    expect(() => parseExperimentSpec({ ...base, reps: MAX_REPS + 1 })).toThrow(/reps must be/);
    expect(() => parseExperimentSpec({ ...base, reps: 1.5 })).toThrow(/reps must be/);
    expect(() => parseExperimentSpec({ ...base, costCapUsd: MAX_COST_CAP_USD + 1 })).toThrow(/costCapUsd/);
    expect(() => parseExperimentSpec({ ...base, costCapUsd: Number.NaN })).toThrow(/costCapUsd/);
    expect(parseExperimentSpec({ ...base, costCapUsd: MAX_COST_CAP_USD }).costCapUsd).toBe(MAX_COST_CAP_USD);
  });

  it('rejects repeated arms and prompts, and a non-object spec', () => {
    expect(() => parseExperimentSpec({ ...base, variants: ['a', 'a'] })).toThrow(/must not repeat an arm/);
    expect(() => parseExperimentSpec({ ...base, commits: ['x', 'x'] })).toThrow(/must not repeat a prompt/);
    expect(() => parseExperimentSpec([base])).toThrow(/must be a JSON object/);
    expect(() => parseExperimentSpec(null)).toThrow(/must be a JSON object/);
  });
});

describe('decideNextRep', () => {
  it('always runs the first repetition', () => {
    expect(decideNextRep({ capUsd: 1, spentUsd: 0, lastRepUsd: null })).toEqual({ stop: false, projectedUsd: 0 });
  });

  it('stops when another repetition like the last, with the judging margin, would pass the cap', () => {
    // spent 8 + next 8 = 16, × margin = 20 → exactly at a 20 cap runs; above it stops
    expect(decideNextRep({ capUsd: 20, spentUsd: 8, lastRepUsd: 8 })).toEqual({ stop: false, projectedUsd: 16 * JUDGING_MARGIN });
    expect(decideNextRep({ capUsd: 19.99, spentUsd: 8, lastRepUsd: 8 }).stop).toBe(true);
  });
});
