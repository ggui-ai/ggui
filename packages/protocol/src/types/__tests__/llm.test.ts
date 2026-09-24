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
  isModelId,
  type ModelConfig,
  type ModelId,
} from '../llm.js';
import { isValidLlmRoute, modelRefOfRoute, type LlmRoute } from '../llm-route.js';

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
      'anthropic/claude-opus-5-5': { in: 4, out: 20, floor: '2027-09-22' },
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
  it('the legacy set is exactly Fable 5, Opus 5, Opus 4.7, Opus 4.6, Sonnet 4.6 — everything else is active (ggui#1266: Opus 5.5 replaces Opus 5)', () => {
    const legacy = ids().filter((id) => MODEL_REGISTRY[id].state === 'legacy');
    expect(legacy).toEqual([
      'anthropic/claude-fable-5',
      'anthropic/claude-opus-4-6',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-4-6',
    ]);
    for (const id of ids()) {
      expect(['active', 'legacy'], id).toContain(MODEL_REGISTRY[id].state);
    }
  });

  it('the lineup is exactly Fable 5.1 · Opus 5.5 · Sonnet 5 · Haiku 4.5 · GPT-6 Luna, every member active, derived once (ggui#1266: the first OpenAI row on the front page)', () => {
    const lineup = ids().filter((id) => MODEL_REGISTRY[id].lineup);
    expect(lineup).toEqual([
      'anthropic/claude-fable-5-1',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5',
      'openai/gpt-6-luna',
    ]);
    expect([...MODEL_LINEUP].sort()).toEqual(lineup);
    for (const id of lineup) expect(MODEL_REGISTRY[id].state, id).toBe('active');
    expect(isLineupModel('anthropic/claude-fable-5-1')).toBe(true);
    expect(isLineupModel('anthropic/claude-fable-5')).toBe(false);
    // ggui#1266 — Opus 5 is legacy (still selectable under "See all models"), off the front page.
    expect(isLineupModel('anthropic/claude-opus-5')).toBe(false);
    expect(MODEL_REGISTRY['anthropic/claude-opus-5'].state).toBe('legacy');
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

/**
 * ggui#977 — Exp 008's founder-ruled second arm. Every number below is a
 * receipt on the issue (2026-09-09): existence `GET /v1/models/gpt-6-astra`
 * → 200; pricing from platform.openai.com/docs/pricing, standard
 * short-context tier ($10 input / $1 cached input / $12.50 cache writes /
 * $50 output per 1M); context window 922,000 and tool support from
 * developers.openai.com/api/docs/models/gpt-6-astra. No retirement date is
 * published, so `retireNotBefore` is unset. Not in the lineup: an
 * experiment arm, like Sol.
 */
describe('MODEL_REGISTRY — GPT-6 Astra row (ggui#977)', () => {
  it('carries openai/gpt-6-astra exactly as receipted on ggui#977', () => {
    const row = MODEL_REGISTRY['openai/gpt-6-astra'];
    expect(row).toEqual({
      id: 'openai/gpt-6-astra',
      provider: 'openai',
      displayName: 'GPT-6 Astra',
      tier: 'premium',
      state: 'active',
      lineup: false,
      costs: {
        inputPer1M: 10.0,
        outputPer1M: 50.0,
        cacheWritePer1M: 12.5,
        cacheReadPer1M: 1.0,
      },
      maxTokens: 922000,
      supportsTools: true,
    });
    expect(isModelId('openai/gpt-6-astra')).toBe(true);
    expect(isLineupModel('openai/gpt-6-astra')).toBe(false);
  });

  it('routes: the allowlist admits it and the registry id is its ModelRef', () => {
    expect(isValidLlmRoute('openai', 'gpt-6-astra')).toBe(true);
    const ref = modelRefOfRoute({ provider: 'openai', model: 'gpt-6-astra' });
    expect(ref).toBe('openai/gpt-6-astra');
    expect(isModelId(ref)).toBe(true);
  });
});

/**
 * ggui#1252 (2026-09-23) — the support batch's three rows (ggui#1251: support
 * ships, no default moves, none joins the lineup — ggui#1266 later puts Opus
 * 5.5 and GPT-6 Luna on the lineup, pinned above). Every number is quoted on
 * the issue from the vendor page, fetched 2026-09-23:
 *   - platform.claude.com pricing: "Claude Opus 5.5 | $4 / MTok | $5 / MTok |
 *     $8 / MTok | $0.20 / MTok | $20 / MTok", footnote 2 "0.05x the base
 *     input price"; model-deprecations "claude-opus-5-5 | Active | N/A | Not
 *     sooner than September 22, 2027".
 *   - developers.openai.com models/gpt-6-sol and /gpt-6-luna: "1,050,000
 *     context window"; Sol $2 / $0.2 cached / $2.5 cache writes / $10; Luna
 *     $0.1 / $0.01 / $0.125 / $0.5; snapshot = the alias; no retirement date.
 * `maxTokens` is the context window on every row (#977's semantics), so the
 * OpenAI rows read 1050000 — the pages' "Maximum input tokens: 922,000" is a
 * different quantity.
 */
describe('MODEL_REGISTRY — the new-models support rows (ggui#1252)', () => {
  it('carries anthropic/claude-opus-5-5 exactly as quoted: 4 / 20, write 5, read 0.2 (0.05×), floor 2027-09-22, on the lineup since ggui#1266', () => {
    expect(MODEL_REGISTRY['anthropic/claude-opus-5-5']).toEqual({
      id: 'anthropic/claude-opus-5-5',
      provider: 'anthropic',
      displayName: 'Claude Opus 5.5',
      tier: 'premium',
      state: 'active',
      lineup: true,
      retireNotBefore: '2027-09-22',
      costs: { inputPer1M: 4.0, outputPer1M: 20.0, cacheWritePer1M: 5.0, cacheReadPer1M: 0.2 },
      maxTokens: 1000000,
      supportsTools: true,
    });
  });

  it('carries openai/gpt-6-sol exactly as quoted: 2 / 10, write 2.5, read 0.2, 1,050,000 context, no floor, not lineup', () => {
    expect(MODEL_REGISTRY['openai/gpt-6-sol']).toEqual({
      id: 'openai/gpt-6-sol',
      provider: 'openai',
      displayName: 'GPT-6 Sol',
      tier: 'balanced',
      state: 'active',
      lineup: false,
      costs: { inputPer1M: 2.0, outputPer1M: 10.0, cacheWritePer1M: 2.5, cacheReadPer1M: 0.2 },
      maxTokens: 1050000,
      supportsTools: true,
    });
  });

  it('carries openai/gpt-6-luna exactly as quoted: 0.1 / 0.5, write 0.125, read 0.01, 1,050,000 context, no floor, on the lineup since ggui#1266', () => {
    expect(MODEL_REGISTRY['openai/gpt-6-luna']).toEqual({
      id: 'openai/gpt-6-luna',
      provider: 'openai',
      displayName: 'GPT-6 Luna',
      tier: 'fast',
      state: 'active',
      lineup: true,
      costs: { inputPer1M: 0.1, outputPer1M: 0.5, cacheWritePer1M: 0.125, cacheReadPer1M: 0.01 },
      maxTokens: 1050000,
      supportsTools: true,
    });
  });

  it('routes: each allowlist admits its id and the registry id is its ModelRef — both serialization forms parse', () => {
    const routes: readonly LlmRoute[] = [
      { provider: 'anthropic', model: 'claude-opus-5-5' },
      { provider: 'openai', model: 'gpt-6-sol' },
      { provider: 'openai', model: 'gpt-6-luna' },
    ];
    for (const route of routes) {
      expect(isValidLlmRoute(route.provider, route.model), `${route.provider}:${route.model}`).toBe(true);
      const ref = modelRefOfRoute(route);
      expect(ref).toBe(`${route.provider}/${route.model}`);
      if (!isModelId(ref)) throw new Error(`${ref} is not a registry ModelId`);
    }
  });

  it('DEFAULT_MODEL is unchanged by the support batch and by the lineup flip (ggui#1266); the pool default is the deployment\'s, not this constant', () => {
    expect(DEFAULT_MODEL).toBe('anthropic/claude-haiku-4-5');
  });
});
