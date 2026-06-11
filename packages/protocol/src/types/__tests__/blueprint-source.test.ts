import { describe, it, expect } from 'vitest';
import {
  BLUEPRINT_SOURCE_KINDS,
  isBlueprintSource,
  parseBlueprintSource,
} from '../blueprint-source.js';

describe('parseBlueprintSource', () => {
  it('parses the llm arm with required generator + model', () => {
    expect(
      parseBlueprintSource({ kind: 'llm', generator: 'ui-gen-default', model: 'm-1' }),
    ).toEqual({ kind: 'llm', generator: 'ui-gen-default', model: 'm-1' });
  });

  it('rejects an llm arm missing generator or model — not a real state', () => {
    expect(parseBlueprintSource({ kind: 'llm' })).toBeNull();
    expect(parseBlueprintSource({ kind: 'llm', generator: 'g' })).toBeNull();
    expect(parseBlueprintSource({ kind: 'llm', model: 'm' })).toBeNull();
    expect(parseBlueprintSource({ kind: 'llm', generator: '', model: 'm' })).toBeNull();
    expect(parseBlueprintSource({ kind: 'llm', generator: 'g', model: '' })).toBeNull();
    expect(parseBlueprintSource({ kind: 'llm', generator: 42, model: 'm' })).toBeNull();
  });

  it('parses the user and curated arms', () => {
    expect(parseBlueprintSource({ kind: 'user' })).toEqual({ kind: 'user' });
    expect(parseBlueprintSource({ kind: 'curated' })).toEqual({ kind: 'curated' });
  });

  it('rebuilds canonically — stray keys are dropped', () => {
    expect(parseBlueprintSource({ kind: 'user', generator: 'stray' })).toEqual({
      kind: 'user',
    });
  });

  it('rejects the dead heuristic arm (never minted; deleted, not carried)', () => {
    expect(parseBlueprintSource({ kind: 'heuristic' })).toBeNull();
    expect(BLUEPRINT_SOURCE_KINDS).not.toContain('heuristic');
  });

  it('rejects legacy flat strings — no coercion of unlabeled provenance', () => {
    expect(parseBlueprintSource('curated')).toBeNull();
    expect(parseBlueprintSource('llm')).toBeNull();
    expect(parseBlueprintSource('synth')).toBeNull();
    expect(parseBlueprintSource('user')).toBeNull();
  });

  it('rejects non-objects and unknown kinds', () => {
    expect(parseBlueprintSource(undefined)).toBeNull();
    expect(parseBlueprintSource(null)).toBeNull();
    expect(parseBlueprintSource([])).toBeNull();
    expect(parseBlueprintSource({})).toBeNull();
    expect(parseBlueprintSource({ kind: 'register' })).toBeNull();
  });
});

describe('isBlueprintSource', () => {
  it('mirrors parseBlueprintSource', () => {
    expect(isBlueprintSource({ kind: 'user' })).toBe(true);
    expect(isBlueprintSource({ kind: 'llm', generator: 'g', model: 'm' })).toBe(true);
    expect(isBlueprintSource({ kind: 'llm' })).toBe(false);
    expect(isBlueprintSource('curated')).toBe(false);
  });
});
