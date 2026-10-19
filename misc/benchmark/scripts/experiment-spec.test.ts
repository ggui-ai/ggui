import { describe, it, expect } from 'vitest';
import {
  JUDGING_MARGIN,
  MAX_COST_CAP_USD,
  MAX_REPS,
  NIGHTLY_COMMITS,
  decideNextRep,
  imageFromContainerMetadata,
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

describe('imageFromContainerMetadata (#1789)', () => {
  const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;

  it('names the digest the task is running and the reference it came from', () => {
    const doc = { Image: '437064342055.dkr.ecr.us-east-1.amazonaws.com/ggui-benchmark-runner:latest', ImageID: digest };
    expect(imageFromContainerMetadata(doc)).toEqual({ ref: doc.Image, digest });
  });

  it('keeps the digest when the reference is missing', () => {
    expect(imageFromContainerMetadata({ ImageID: digest })).toEqual({ ref: null, digest });
  });

  it('refuses a document whose ImageID is not a sha256 digest, so a receipt never records a guess', () => {
    expect(() => imageFromContainerMetadata({ Image: 'x:latest' })).toThrow(/ImageID is not a sha256 digest/);
    expect(() => imageFromContainerMetadata({ ImageID: 'sha256:abc' })).toThrow(/ImageID is not a sha256 digest/);
    expect(() => imageFromContainerMetadata({ ImageID: 'latest' })).toThrow(/ImageID is not a sha256 digest/);
  });

  it('refuses a document that is not an object', () => {
    expect(() => imageFromContainerMetadata(null)).toThrow(/not a JSON object/);
    expect(() => imageFromContainerMetadata([])).toThrow(/not a JSON object/);
    expect(() => imageFromContainerMetadata('sha256:x')).toThrow(/not a JSON object/);
  });
});
