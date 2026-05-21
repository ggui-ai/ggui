import { describe, expect, it } from 'vitest';
import {
  findNearDuplicatePersona,
  levenshtein,
  normalizePersona,
} from './persona-normalization.js';

describe('normalizePersona', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizePersona(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(normalizePersona('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only input', () => {
    expect(normalizePersona('   ')).toBeUndefined();
    expect(normalizePersona('\t\n  ')).toBeUndefined();
  });

  it('lowercases mixed-case input', () => {
    expect(normalizePersona('Minimalist')).toBe('minimalist');
    expect(normalizePersona('DATA-DENSE')).toBe('data-dense');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizePersona('  data-dense  ')).toBe('data-dense');
    expect(normalizePersona('\tcasual\n')).toBe('casual');
  });

  it('preserves internal whitespace verbatim', () => {
    expect(normalizePersona('Weekly Digest')).toBe('weekly digest');
  });

  it('preserves dashes', () => {
    expect(normalizePersona('Data-Dense')).toBe('data-dense');
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
    expect(levenshtein('', '')).toBe(0);
  });

  it('returns length when one side is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts single insertion', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
  });

  it('counts single deletion', () => {
    expect(levenshtein('cats', 'cat')).toBe(1);
  });

  it('counts single substitution', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('counts multiple edits', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('saturday', 'sunday')).toBe(3);
  });

  it('is symmetric', () => {
    expect(levenshtein('abc', 'xyz')).toBe(levenshtein('xyz', 'abc'));
    expect(levenshtein('foo', 'foobar')).toBe(levenshtein('foobar', 'foo'));
  });
});

describe('findNearDuplicatePersona', () => {
  it('returns null when no near-duplicate exists', () => {
    expect(
      findNearDuplicatePersona('minimalist', ['data-dense', 'casual']),
    ).toBeNull();
  });

  it('flags identical match at distance 0', () => {
    const result = findNearDuplicatePersona('data-dense', [
      'data-dense',
      'casual',
    ]);
    expect(result).not.toBeNull();
    expect(result?.nearestDistance).toBe(0);
    expect(result?.nearestExisting).toBe('data-dense');
    expect(result?.newPersona).toBe('data-dense');
  });

  it('flags distance-1 near-duplicate', () => {
    const result = findNearDuplicatePersona('minimalst', [
      'minimalist',
      'casual',
    ]);
    expect(result).not.toBeNull();
    expect(result?.nearestDistance).toBe(1);
    expect(result?.nearestExisting).toBe('minimalist');
  });

  it('does NOT flag distance-2 cousins as near-duplicates', () => {
    // 'chart' vs 'chat' is distance 1 (delete 'r'), but 'chart' vs
    // 'check' is distance 3. Distance ≥ 2 is the "legitimate
    // cousins" floor.
    expect(findNearDuplicatePersona('chart', ['check'])).toBeNull();
  });

  it('does NOT flag distance-2 case as near-duplicate', () => {
    // 'abc' vs 'xyz' = distance 3. 'abc' vs 'abd' = distance 1
    // (substitution). Test the boundary: distance exactly 2 isn't
    // flagged.
    // 'abcd' vs 'wxyz' = 4. 'abcd' vs 'abxy' = 2 (substitute c,d → x,y).
    expect(findNearDuplicatePersona('abcd', ['abxy'])).toBeNull();
  });

  it('returns the closest existing persona when multiple are near', () => {
    // 'data-dense' is distance 0 → identical match short-circuits.
    const result = findNearDuplicatePersona('data-dense', [
      'data-dens',
      'data-dense',
      'data-denses',
    ]);
    expect(result?.nearestExisting).toBe('data-dense');
    expect(result?.nearestDistance).toBe(0);
  });

  it('returns the closest existing persona when no identical match', () => {
    const result = findNearDuplicatePersona('minimalst', [
      'casual',
      'minimalist',
      'maximalist',
    ]);
    expect(result?.nearestExisting).toBe('minimalist');
    expect(result?.nearestDistance).toBe(1);
  });

  it('handles empty existing set', () => {
    expect(findNearDuplicatePersona('data-dense', [])).toBeNull();
  });
});
