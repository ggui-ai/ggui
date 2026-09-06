import { describe, expect, it } from 'vitest';
import {
  formatGeneratorSlug,
  isValidGeneratorSlug,
  parseGeneratorSlug,
} from './generator-registry.js';

describe('parseGeneratorSlug', () => {
  it('parses the default seed slug', () => {
    expect(parseGeneratorSlug('ui-gen-default')).toEqual({ tier: 'default' });
  });

  it('parses the advanced slug', () => {
    expect(parseGeneratorSlug('ui-gen-advanced')).toEqual({ tier: 'advanced' });
  });

  it('accepts operator-defined tier values', () => {
    expect(parseGeneratorSlug('ui-gen-enterprise')).toEqual({ tier: 'enterprise' });
  });

  it('rejects missing prefix', () => {
    expect(parseGeneratorSlug('default')).toBeNull();
    expect(parseGeneratorSlug('ui-default')).toBeNull();
    expect(parseGeneratorSlug('gen-default')).toBeNull();
  });

  it('rejects empty tier', () => {
    expect(parseGeneratorSlug('ui-gen-')).toBeNull();
    expect(parseGeneratorSlug('ui-gen--')).toBeNull();
  });

  it('rejects a dash in the tier — the identity carries no model segment (ggui#923)', () => {
    expect(parseGeneratorSlug('ui-gen-default-some-model')).toBeNull();
    expect(parseGeneratorSlug('ui-gen-default-')).toBeNull();
    expect(parseGeneratorSlug('ui-gen-a-b')).toBeNull();
  });

  it('rejects whitespace anywhere', () => {
    expect(parseGeneratorSlug('ui-gen-def ault')).toBeNull();
    expect(parseGeneratorSlug(' ui-gen-default')).toBeNull();
    expect(parseGeneratorSlug('ui-gen-default ')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(parseGeneratorSlug(null as unknown as string)).toBeNull();
    expect(parseGeneratorSlug(undefined as unknown as string)).toBeNull();
    expect(parseGeneratorSlug(42 as unknown as string)).toBeNull();
  });
});

describe('isValidGeneratorSlug', () => {
  it('returns true for valid slugs', () => {
    expect(isValidGeneratorSlug('ui-gen-default')).toBe(true);
    expect(isValidGeneratorSlug('ui-gen-advanced')).toBe(true);
  });

  it('returns false for invalid slugs', () => {
    expect(isValidGeneratorSlug('not-a-slug')).toBe(false);
    expect(isValidGeneratorSlug('ui-gen-')).toBe(false);
    expect(isValidGeneratorSlug('ui-gen-default-some-model')).toBe(false);
    expect(isValidGeneratorSlug('')).toBe(false);
  });
});

describe('formatGeneratorSlug', () => {
  it('round-trips with parseGeneratorSlug', () => {
    const slug = 'ui-gen-default';
    const parts = parseGeneratorSlug(slug);
    expect(parts).not.toBeNull();
    expect(formatGeneratorSlug(parts!)).toBe(slug);
  });

  it('builds the advanced slug from its tier alone', () => {
    expect(formatGeneratorSlug({ tier: 'advanced' })).toBe('ui-gen-advanced');
  });

  it('rejects empty tier', () => {
    expect(() => formatGeneratorSlug({ tier: '' })).toThrow(/tier must be a non-empty/);
  });

  it('rejects whitespace in tier', () => {
    expect(() => formatGeneratorSlug({ tier: 'default ' })).toThrow(/tier must be/);
    expect(() => formatGeneratorSlug({ tier: 'def ault' })).toThrow(/tier must be/);
  });

  it('rejects dash in tier (the identity is one segment)', () => {
    expect(() => formatGeneratorSlug({ tier: 'default-mode' })).toThrow(/tier must be/);
  });
});
