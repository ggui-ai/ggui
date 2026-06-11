import { describe, it, expect } from 'vitest';
import {
  BLUEPRINT_SOURCE_KINDS,
  FLAT_BLUEPRINT_SOURCE_KEYS,
  blueprintSourceToFlat,
  flatToBlueprintSource,
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

describe('flat-provenance codec (blueprintSourceToFlat / flatToBlueprintSource)', () => {
  it('flattens the llm arm to the full sourceKind/sourceGenerator/sourceModel triple', () => {
    expect(
      blueprintSourceToFlat({ kind: 'llm', generator: 'ui-gen-default', model: 'm-1' }),
    ).toEqual({ sourceKind: 'llm', sourceGenerator: 'ui-gen-default', sourceModel: 'm-1' });
  });

  it('flattens non-llm arms to the bare sourceKind — no vestigial scalars', () => {
    expect(blueprintSourceToFlat({ kind: 'user' })).toEqual({ sourceKind: 'user' });
    expect(blueprintSourceToFlat({ kind: 'curated' })).toEqual({ sourceKind: 'curated' });
  });

  it('round-trips every arm through the flat encoding', () => {
    const arms = [
      { kind: 'llm', generator: 'g', model: 'm' },
      { kind: 'user' },
      { kind: 'curated' },
    ] as const;
    for (const arm of arms) {
      expect(flatToBlueprintSource(blueprintSourceToFlat(arm))).toEqual(arm);
    }
  });

  it('rebuilds from a wider row object — only the codec keys are read', () => {
    // Untrusted-row fixture (the narrower's real input shape at DDB /
    // metadata trust boundaries).
    const row: Record<string, unknown> = {
      blueprintId: 'bp-1',
      sourceKind: 'llm',
      sourceGenerator: 'g',
      sourceModel: 'm',
      score: 3,
    };
    expect(flatToBlueprintSource(row)).toEqual({ kind: 'llm', generator: 'g', model: 'm' });
  });

  it('sheds vestigial sourceGenerator/sourceModel on non-llm rows (canonical rebuild)', () => {
    expect(
      flatToBlueprintSource({ sourceKind: 'curated', sourceGenerator: 'stray', sourceModel: 'stray' }),
    ).toEqual({ kind: 'curated' });
  });

  it('rejects unlabeled / malformed rows — never coerces', () => {
    expect(flatToBlueprintSource({})).toBeNull();
    expect(flatToBlueprintSource({ sourceKind: 'llm' })).toBeNull();
    expect(flatToBlueprintSource({ sourceKind: 'llm', sourceGenerator: 'g' })).toBeNull();
    expect(flatToBlueprintSource({ sourceKind: 'heuristic' })).toBeNull();
    // Retired flat `provenance` vocabulary rows carry no sourceKind.
    const legacyRow: Record<string, unknown> = { provenance: 'curated' };
    expect(flatToBlueprintSource(legacyRow)).toBeNull();
  });

  it('pins the storage key vocabulary — a key rename is a re-seed event, not a drift', () => {
    expect(FLAT_BLUEPRINT_SOURCE_KEYS).toEqual({
      kind: 'sourceKind',
      generator: 'sourceGenerator',
      model: 'sourceModel',
    });
  });
});
