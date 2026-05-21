import { describe, it, expect } from 'vitest';
import { readEvalScore, readDimensions } from './eval-helpers';

describe('readEvalScore', () => {
  it('returns finalScore when present and numeric', () => {
    expect(readEvalScore({ finalScore: 88, dimensions: {} })).toBe(88);
    expect(readEvalScore({ finalScore: 0 })).toBe(0);
  });

  it('returns null for null/undefined evaluation', () => {
    expect(readEvalScore(null)).toBe(null);
    expect(readEvalScore(undefined)).toBe(null);
  });

  it('returns null when finalScore is missing', () => {
    expect(readEvalScore({ overallScore: 88 })).toBe(null); // legacy field, ignored
    expect(readEvalScore({})).toBe(null);
  });

  it('returns null when finalScore is non-numeric', () => {
    expect(readEvalScore({ finalScore: '88' })).toBe(null);
    expect(readEvalScore({ finalScore: null })).toBe(null);
  });

  it('returns null for primitives', () => {
    expect(readEvalScore('not an object')).toBe(null);
    expect(readEvalScore(42)).toBe(null);
  });
});

describe('readDimensions', () => {
  const valid = {
    completeness: 90,
    visualPolish: 85,
    interactivity: 88,
    accessibility: 92,
    codeQuality: 87,
  };

  it('returns the 5-axis shape when all present', () => {
    expect(readDimensions({ dimensions: valid })).toEqual(valid);
  });

  it('strips extra properties', () => {
    const withExtra = { ...valid, intent: 'extra', extraneous: 99 };
    const result = readDimensions({ dimensions: withExtra });
    expect(result).toEqual(valid);
    expect(result).not.toHaveProperty('intent');
  });

  it('returns null when any axis is missing', () => {
    const { codeQuality, ...incomplete } = valid;
    void codeQuality;
    expect(readDimensions({ dimensions: incomplete })).toBe(null);
  });

  it('returns null when any axis is non-numeric', () => {
    expect(
      readDimensions({ dimensions: { ...valid, completeness: 'high' } }),
    ).toBe(null);
  });

  it('returns null for missing dimensions field', () => {
    expect(readDimensions({ dimensionScores: valid })).toBe(null); // legacy field
    expect(readDimensions({})).toBe(null);
    expect(readDimensions(null)).toBe(null);
  });
});
