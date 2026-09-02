/**
 * MODEL_REGISTRY — the row set every other surface reads (ggui#707, the
 * Fable 5.1 sweep keystone). Every string below is quoted from ggui#706's
 * verified table (platform.claude.com, 2026-09-02); nothing is typed from
 * memory. `state` and `lineup` are REQUIRED registry facts so a picker
 * never holds its own list and a new row cannot silently fall out of
 * both groups.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEFAULT_MODEL,
  MODEL_LINEUP,
  MODEL_REGISTRY,
  isLineupModel,
  type ModelConfig,
  type ModelId,
} from '../llm.js';

const ids = (): ModelId[] => Object.keys(MODEL_REGISTRY).sort() as ModelId[];

describe('MODEL_REGISTRY — Fable 5.1 row (ggui#707)', () => {
  it('carries anthropic/claude-fable-5-1 exactly as verified on ggui#706', () => {
    const row = MODEL_REGISTRY['anthropic/claude-fable-5-1'];
    expect(row).toMatchObject({
      id: 'anthropic/claude-fable-5-1',
      provider: 'anthropic',
      displayName: 'Claude Fable 5.1',
      tier: 'premium',
      state: 'active',
      lineup: true,
      maxTokens: 1000000,
      supportsTools: true,
      retireNotBefore: '2027-09-01',
    });
    expect(row.costs).toEqual({
      inputPer1M: 10.0,
      outputPer1M: 50.0,
      cacheWritePer1M: 12.5,
      // 0.025× the input price on Fable 5.1 (pricing docs footnote; every
      // other model keeps the 0.1× multiplier) — $0.25 / MTok.
      cacheReadPer1M: 0.25,
    });
  });

  it('the 5-family + Haiku 4.5 prices and retirement floors match ggui#706', () => {
    const expected: Record<string, { in: number; out: number; floor: string }> = {
      'anthropic/claude-opus-5': { in: 5, out: 25, floor: '2027-07-24' },
      'anthropic/claude-sonnet-5': { in: 2, out: 10, floor: '2027-06-30' },
      'anthropic/claude-haiku-4-5': { in: 1, out: 5, floor: '2026-10-15' },
      'anthropic/claude-fable-5': { in: 10, out: 50, floor: '2027-06-09' },
    };
    for (const [id, e] of Object.entries(expected)) {
      const row = MODEL_REGISTRY[id as ModelId];
      expect(row.costs.inputPer1M, id).toBe(e.in);
      expect(row.costs.outputPer1M, id).toBe(e.out);
      expect(row.retireNotBefore, id).toBe(e.floor);
    }
  });
});

describe('MODEL_REGISTRY — state + lineup are registry facts', () => {
  it('the legacy set is exactly Fable 5, Opus 4.7, Opus 4.6, Sonnet 4.6 — everything else is active', () => {
    const legacy = ids().filter((id) => MODEL_REGISTRY[id].state === 'legacy');
    expect(legacy).toEqual([
      'anthropic/claude-fable-5',
      'anthropic/claude-opus-4-6',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-sonnet-4-6',
    ]);
    for (const id of ids()) {
      expect(['active', 'legacy'], id).toContain(MODEL_REGISTRY[id].state);
    }
  });

  it('the lineup is exactly Fable 5.1 · Opus 5 · Sonnet 5 · Haiku 4.5, every member active, derived once', () => {
    const lineup = ids().filter((id) => MODEL_REGISTRY[id].lineup);
    expect(lineup).toEqual([
      'anthropic/claude-fable-5-1',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-5',
    ]);
    expect([...MODEL_LINEUP].sort()).toEqual(lineup);
    for (const id of lineup) expect(MODEL_REGISTRY[id].state, id).toBe('active');
    expect(isLineupModel('anthropic/claude-fable-5-1')).toBe(true);
    expect(isLineupModel('anthropic/claude-fable-5')).toBe(false);
    expect(isLineupModel('openai/gpt-5.4')).toBe(false);
  });

  it('DEFAULT_MODEL stays Haiku 4.5 until the founder rules (ggui#706 decision 1) and is a lineup member', () => {
    expect(DEFAULT_MODEL).toBe('anthropic/claude-haiku-4-5');
    expect(isLineupModel(DEFAULT_MODEL)).toBe(true);
    expect(MODEL_REGISTRY[DEFAULT_MODEL].state).toBe('active');
  });
});

describe('MODEL_REGISTRY — ModelId derives from the rows (no second list)', () => {
  it("every row's id equals its key", () => {
    for (const id of ids()) expect(MODEL_REGISTRY[id].id).toBe(id);
  });

  it('ModelId is the key set of the registry and every row is a ModelConfig', () => {
    expectTypeOf<ModelId>().toEqualTypeOf<keyof typeof MODEL_REGISTRY>();
    const row: ModelConfig = MODEL_REGISTRY['anthropic/claude-fable-5-1'];
    expect(row.id).toBe('anthropic/claude-fable-5-1');
  });
});
