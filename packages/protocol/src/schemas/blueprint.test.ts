// Protocol-side schema tests for `blueprintVarianceSchema` — the single
// shared variance schema reused by every seam that accepts a variance
// block (handshake draft, render override, operator blueprint
// tools). Pinning its parse + strict behavior here means every
// downstream consumer inherits the same rule.

import { describe, it, expect } from 'vitest';
import { llmBlueprintSourceSchema } from './blueprint';
import { blueprintSchema, blueprintSourceSchema, blueprintVarianceSchema, generatorBuildSchema } from './blueprint';

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
      generator: 'ui-gen-default',
      model: 'anthropic/claude-haiku-4-5',
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

describe('llmBlueprintSourceSchema — mirrors the tightened source (ggui#924)', () => {
  it('parses the de-modeled identity + a registry model, and refuses a modeled id or a bare model name', () => {
    expect(llmBlueprintSourceSchema.parse({ kind: 'llm', generator: 'ui-gen-default', model: 'anthropic/claude-haiku-4-5' })).toEqual({
      kind: 'llm',
      generator: 'ui-gen-default',
      model: 'anthropic/claude-haiku-4-5',
    });
    expect(llmBlueprintSourceSchema.safeParse({ kind: 'llm', generator: 'ui-gen-default-haiku-4-5', model: 'anthropic/claude-haiku-4-5' }).success).toBe(false);
    expect(llmBlueprintSourceSchema.safeParse({ kind: 'llm', generator: 'ui-gen-advanced', model: 'claude-opus-4-7' }).success).toBe(false);
  });
});

// ggui#1280 — the minting engine's build stamp on the durable record.
const DIGEST = 'a'.repeat(64);
const baseRow = {
  blueprintId: 'bp-1',
  contractHash: 'hash-1',
  appId: 'app-1',
  source: { kind: 'llm', generator: 'ui-gen-default', model: 'anthropic/claude-haiku-4-5' },
  variance: {},
  createdAt: '2026-09-27T00:00:00.000Z',
  createdBy: 'agent',
  contract: { propsSpec: { properties: {} } },
};

describe('generatorBuildSchema + Blueprint.build (ggui#1280, declare step)', () => {
  it('parses a build stamp and is strict about its keys', () => {
    const ok = generatorBuildSchema.safeParse({ version: '0.24.0', mode: 'constrained', digests: { promptTemplateSha256: DIGEST } });
    expect(ok.success).toBe(true);
    expect(generatorBuildSchema.safeParse({ digests: {} }).success).toBe(true); // version/mode optional; an empty digest map is a stamp with nothing to say
    expect(generatorBuildSchema.safeParse({ digests: { x: DIGEST }, extra: 1 }).success).toBe(false);
    expect(generatorBuildSchema.safeParse({ version: '1' }).success).toBe(false); // digests is required
  });
  it('digest values are lowercase hex sha256 — anything else is a bug worth surfacing', () => {
    expect(generatorBuildSchema.safeParse({ digests: { k: 'not-a-digest' } }).success).toBe(false);
    expect(generatorBuildSchema.safeParse({ digests: { k: DIGEST.toUpperCase() } }).success).toBe(false);
  });
  it('blueprintSchema keeps a build stamp and still parses a row without one (N−1: old rows read as unknown)', () => {
    const stamped = blueprintSchema.safeParse({ ...baseRow, build: { mode: 'free', digests: { promptTemplateSha256: DIGEST } } });
    expect(stamped.success).toBe(true);
    if (stamped.success) expect(stamped.data.build).toEqual({ mode: 'free', digests: { promptTemplateSha256: DIGEST } });
    const bare = blueprintSchema.safeParse(baseRow);
    expect(bare.success).toBe(true);
    if (bare.success) expect(bare.data.build).toBeUndefined();
    expect(blueprintSchema.safeParse({ ...baseRow, build: { digests: { k: 'nope' } } }).success).toBe(false);
  });
});

// ggui#1570 — a row that copies another row's bytes says so on itself, in
// `clonedFrom`; its `source` and `build` stay the bytes' (the original's).
describe('Blueprint.clonedFrom — provenance about the row (ggui#1570, declare step)', () => {
  // The row the previous release writes: stamped, and no `clonedFrom`.
  const PREVIOUS_RELEASE_ROW = {
    ...baseRow,
    codeHash: 'b'.repeat(64),
    build: { version: '0.25.0', mode: 'free', digests: { promptTemplateSha256: DIGEST } },
  };
  it("parses the previous release's row unchanged: no clonedFrom, and none is filled in (N−1)", () => {
    const r = blueprintSchema.safeParse(PREVIOUS_RELEASE_ROW);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.clonedFrom).toBeUndefined();
      expect(r.data).toEqual(PREVIOUS_RELEASE_ROW);
    }
  });
  it('keeps a clonedFrom naming the row whose bytes this row copies', () => {
    const r = blueprintSchema.safeParse({ ...PREVIOUS_RELEASE_ROW, blueprintId: 'bp-clone', clonedFrom: 'bp-1' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.clonedFrom).toBe('bp-1');
  });
  it('refuses an empty or non-string clonedFrom', () => {
    expect(blueprintSchema.safeParse({ ...baseRow, clonedFrom: '' }).success).toBe(false);
    expect(blueprintSchema.safeParse({ ...baseRow, clonedFrom: 7 }).success).toBe(false);
    expect(blueprintSchema.safeParse({ ...baseRow, clonedFrom: null }).success).toBe(false);
  });
  it('ships declared before any writer emits it: the strict schema refuses a key it does not name, as the previous release refuses clonedFrom', () => {
    expect(blueprintSchema.safeParse({ ...baseRow, notAField: 'x' }).success).toBe(false);
  });
});
