import { describe, expect, it } from 'vitest';
import {
  formatGeneratorSlug,
  isValidGeneratorSlug,
  parseGeneratorSlug,
} from './generator-registry.js';

describe('parseGeneratorSlug', () => {
  it('parses the default-haiku-4-5 seed slug', () => {
    expect(parseGeneratorSlug('ui-gen-default-haiku-4-5')).toEqual({
      tier: 'default',
      model: 'haiku-4-5',
    });
  });

  it('parses the advanced-opus-4-7 slug (MVB-4)', () => {
    expect(parseGeneratorSlug('ui-gen-advanced-opus-4-7')).toEqual({
      tier: 'advanced',
      model: 'opus-4-7',
    });
  });

  it('preserves dashes inside the model segment', () => {
    expect(parseGeneratorSlug('ui-gen-default-gemini-3-flash')).toEqual({
      tier: 'default',
      model: 'gemini-3-flash',
    });
    expect(parseGeneratorSlug('ui-gen-default-gpt-5-codex')).toEqual({
      tier: 'default',
      model: 'gpt-5-codex',
    });
  });

  it('accepts operator-defined tier values', () => {
    expect(parseGeneratorSlug('ui-gen-enterprise-claude-x')).toEqual({
      tier: 'enterprise',
      model: 'claude-x',
    });
  });

  it('rejects missing prefix', () => {
    expect(parseGeneratorSlug('default-haiku-4-5')).toBeNull();
    expect(parseGeneratorSlug('ui-default-haiku-4-5')).toBeNull();
  });

  it('rejects empty tier', () => {
    expect(parseGeneratorSlug('ui-gen--haiku-4-5')).toBeNull();
  });

  it('rejects empty model', () => {
    expect(parseGeneratorSlug('ui-gen-default-')).toBeNull();
    expect(parseGeneratorSlug('ui-gen-default')).toBeNull();
  });

  it('rejects whitespace anywhere', () => {
    expect(parseGeneratorSlug('ui-gen-default-haiku 4 5')).toBeNull();
    expect(parseGeneratorSlug(' ui-gen-default-haiku-4-5')).toBeNull();
    expect(parseGeneratorSlug('ui-gen-default-haiku-4-5 ')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(parseGeneratorSlug(null as unknown as string)).toBeNull();
    expect(parseGeneratorSlug(undefined as unknown as string)).toBeNull();
    expect(parseGeneratorSlug(42 as unknown as string)).toBeNull();
  });
});

describe('isValidGeneratorSlug', () => {
  it('returns true for valid slugs', () => {
    expect(isValidGeneratorSlug('ui-gen-default-haiku-4-5')).toBe(true);
    expect(isValidGeneratorSlug('ui-gen-advanced-opus-4-7')).toBe(true);
  });

  it('returns false for invalid slugs', () => {
    expect(isValidGeneratorSlug('not-a-slug')).toBe(false);
    expect(isValidGeneratorSlug('ui-gen-')).toBe(false);
    expect(isValidGeneratorSlug('')).toBe(false);
  });
});

describe('formatGeneratorSlug', () => {
  it('round-trips with parseGeneratorSlug', () => {
    const slug = 'ui-gen-default-haiku-4-5';
    const parts = parseGeneratorSlug(slug);
    expect(parts).not.toBeNull();
    expect(formatGeneratorSlug(parts!)).toBe(slug);
  });

  it('builds advanced slug', () => {
    expect(
      formatGeneratorSlug({ tier: 'advanced', model: 'opus-4-7' }),
    ).toBe('ui-gen-advanced-opus-4-7');
  });

  it('rejects empty tier', () => {
    expect(() =>
      formatGeneratorSlug({ tier: '', model: 'haiku-4-5' }),
    ).toThrow(/tier must be a non-empty/);
  });

  it('rejects empty model', () => {
    expect(() =>
      formatGeneratorSlug({ tier: 'default', model: '' }),
    ).toThrow(/model must be a non-empty/);
  });

  it('rejects whitespace in tier or model', () => {
    expect(() =>
      formatGeneratorSlug({ tier: 'default ', model: 'haiku-4-5' }),
    ).toThrow(/tier must be/);
    expect(() =>
      formatGeneratorSlug({ tier: 'default', model: 'haiku 4 5' }),
    ).toThrow(/model must be/);
  });

  it('rejects dash in tier (dashes are reserved as segment separators)', () => {
    expect(() =>
      formatGeneratorSlug({ tier: 'default-mode', model: 'haiku-4-5' }),
    ).toThrow(/tier must be/);
  });
});
