// Protocol-side schema tests for `blueprintVarianceSchema` — the single
// shared variance schema reused by every seam that accepts a variance
// block (handshake draft, render override, operator blueprint
// tools). Pinning its parse + strict behavior here means every
// downstream consumer inherits the same rule.

import { describe, it, expect } from 'vitest';
import { blueprintSourceSchema, blueprintVarianceSchema } from './blueprint';

describe('blueprintVarianceSchema', () => {
  it('parses persona/aesthetic/context/seedPrompt and is strict', () => {
    const v = {
      persona: 'minimalist',
      aesthetic: 'calm',
      context: { situation: 'sad' },
      seedPrompt: 's',
    };
    expect(blueprintVarianceSchema.parse(v)).toEqual(v);
    expect(() => blueprintVarianceSchema.parse({ persona: 'x', bogus: 1 })).toThrow();
  });

  it('accepts an empty variance (every field optional)', () => {
    expect(blueprintVarianceSchema.parse({})).toEqual({});
  });
});

describe('blueprintSourceSchema — zod mirror of parseBlueprintSource', () => {
  it('parses all three arms', () => {
    const llm = {
      kind: 'llm',
      generator: 'ui-gen-default-haiku-4-5',
      model: 'claude-haiku-4-5',
    };
    expect(blueprintSourceSchema.parse(llm)).toEqual(llm);
    expect(blueprintSourceSchema.parse({ kind: 'user' })).toEqual({
      kind: 'user',
    });
    expect(blueprintSourceSchema.parse({ kind: 'curated' })).toEqual({
      kind: 'curated',
    });
  });

  it('rejects an llm arm missing generator or model (both REQUIRED)', () => {
    expect(() =>
      blueprintSourceSchema.parse({ kind: 'llm', generator: 'g' }),
    ).toThrow();
    expect(() =>
      blueprintSourceSchema.parse({ kind: 'llm', model: 'm' }),
    ).toThrow();
    expect(() =>
      blueprintSourceSchema.parse({ kind: 'llm', generator: '', model: 'm' }),
    ).toThrow();
  });

  it('rejects unknown kinds and stray keys (legacy flat vocab never coerces)', () => {
    expect(() => blueprintSourceSchema.parse({ kind: 'heuristic' })).toThrow();
    expect(() => blueprintSourceSchema.parse('curated')).toThrow();
    expect(() =>
      blueprintSourceSchema.parse({ kind: 'user', generator: 'g' }),
    ).toThrow();
  });
});
