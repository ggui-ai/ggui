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
  it('the legacy set is exactly Fable 5, Haiku 4.5, Opus 5, Opus 4.7, Opus 4.6, Sonnet 4.6 — everything else is active (ggui#1266: Opus 5.5 replaces Opus 5; ggui#1743: Haiku 5.5 replaces Haiku 4.5)', () => {
    const legacy = ids().filter((id) => MODEL_REGISTRY[id].state === 'legacy');
    expect(legacy).toEqual([
      'anthropic/claude-fable-5',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-opus-4-6',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-4-6',
    ]);
    for (const id of ids()) {
      expect(['active', 'legacy'], id).toContain(MODEL_REGISTRY[id].state);
    }
  });

  it('the lineup is exactly Fable 5.1 · Haiku 5.5 · Opus 5.5 · Sonnet 5 · GPT-6 Luna, every member active, derived once (ggui#1266: the first OpenAI row on the front page; ggui#1743: Haiku 5.5 replaces Haiku 4.5)', () => {
    const lineup = ids().filter((id) => MODEL_REGISTRY[id].lineup);
    expect(lineup).toEqual([
      'anthropic/claude-fable-5-1',
      'anthropic/claude-haiku-5-5',
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
    // ggui#1743 — Haiku 4.5 the same way: legacy, routable, off the front page.
    expect(isLineupModel('anthropic/claude-haiku-4-5')).toBe(false);
    expect(MODEL_REGISTRY['anthropic/claude-haiku-4-5'].state).toBe('legacy');
    expect(isLineupModel('openai/gpt-5.4')).toBe(false);
  });

  it('DEFAULT_MODEL is Haiku 5.5 (ggui#1743: measured, then switched — stage 1 passed every pre-set bar) and is an active lineup member', () => {
    expect(DEFAULT_MODEL).toBe('anthropic/claude-haiku-5-5');
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

  it('the support batch and the lineup flip (ggui#1266) moved no default; the one move since is ggui#1743\'s measured switch, and the pool default is the deployment\'s, not this constant', () => {
    expect(DEFAULT_MODEL).toBe('anthropic/claude-haiku-5-5');
  });
});

/**
 * ggui#1743 (2026-10-10) — the latest-generation rows, added so the default
 * switch can be MEASURED before it is made: support ships, no default moves,
 * none joins the lineup. Every number is quoted from the vendor page, read
 * 2026-10-10:
 *   - platform.claude.com pricing: "Claude Haiku 5.5 (for prompts up to
 *     100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 /
 *     MTok | $0.50 / MTok" — the row carries this tier; the over-100k tier
 *     ($0.50 / $0.625 / $1 / $0.05 / $2.50) is not modelled, as the 1h cache
 *     write is not. "Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok |
 *     $0.10 / MTok | $10 / MTok", footnote 2: "Cache hits and refreshes on
 *     Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input
 *     price." model-deprecations: "claude-sonnet-5-5 | Active | N/A | Not
 *     sooner than September 28, 2027"; "claude-haiku-5-5 | Active | N/A | Not
 *     sooner than October 7, 2027". models/*-5-5/overview: 1M context, both
 *     dateless ids (the first dateless Haiku).
 *   - developers.openai.com models/gpt-6.1-sol: "1,050,000 context window",
 *     $2 input / $0.10 cached input / $10 output per 1M, Snapshots lists only
 *     `gpt-6.1-sol`, no retirement date. OpenAI publishes no cache-write
 *     price, so `cacheWritePer1M` is unset (consumers fall back to input).
 *   - ai.google.dev/gemini-api/docs/pricing: Gemini 3.8 Flash "$0.75 through
 *     December 31, 2026. $1.50 starting January 1, 2027" / "$3.75 … $7.50" /
 *     context caching "$0.075 … $0.15"; docs/models lists `gemini-3.8-flash`
 *     as stable. Context 1,048,576 as on every Flash row.
 */
describe('MODEL_REGISTRY — the latest-generation rows (ggui#1743)', () => {
  it('carries anthropic/claude-haiku-5-5 exactly as quoted (the ≤100k-prompt tier): 0.1 / 0.5, write 0.125, read 0.01, floor 2027-10-07, on the lineup since the measured switch', () => {
    expect(MODEL_REGISTRY['anthropic/claude-haiku-5-5']).toEqual({
      id: 'anthropic/claude-haiku-5-5',
      provider: 'anthropic',
      displayName: 'Claude Haiku 5.5',
      tier: 'fast',
      state: 'active',
      lineup: true,
      retireNotBefore: '2027-10-07',
      costs: { inputPer1M: 0.1, outputPer1M: 0.5, cacheWritePer1M: 0.125, cacheReadPer1M: 0.01 },
      maxTokens: 1000000,
      supportsTools: true,
    });
  });

  it('carries anthropic/claude-sonnet-5-5 exactly as quoted: 2 / 10, write 2.5, read 0.1 (0.05×), floor 2027-09-28, not lineup', () => {
    expect(MODEL_REGISTRY['anthropic/claude-sonnet-5-5']).toEqual({
      id: 'anthropic/claude-sonnet-5-5',
      provider: 'anthropic',
      displayName: 'Claude Sonnet 5.5',
      tier: 'balanced',
      state: 'active',
      lineup: false,
      retireNotBefore: '2027-09-28',
      costs: { inputPer1M: 2.0, outputPer1M: 10.0, cacheWritePer1M: 2.5, cacheReadPer1M: 0.1 },
      maxTokens: 1000000,
      supportsTools: true,
    });
  });

  it('carries openai/gpt-6.1-sol exactly as quoted: 2 / 10, read 0.1, no cache-write price, 1,050,000 context, no floor, not lineup', () => {
    expect(MODEL_REGISTRY['openai/gpt-6.1-sol']).toEqual({
      id: 'openai/gpt-6.1-sol',
      provider: 'openai',
      displayName: 'GPT-6.1 Sol',
      tier: 'balanced',
      state: 'active',
      lineup: false,
      costs: { inputPer1M: 2.0, outputPer1M: 10.0, cacheReadPer1M: 0.1 },
      maxTokens: 1050000,
      supportsTools: true,
    });
  });

  it('carries gemini/gemini-3.8-flash exactly as quoted (the introductory rate): 0.75 / 3.75, cache read 0.075, no floor, not lineup', () => {
    expect(MODEL_REGISTRY['gemini/gemini-3.8-flash']).toEqual({
      id: 'gemini/gemini-3.8-flash',
      provider: 'google',
      displayName: 'Gemini 3.8 Flash',
      tier: 'balanced',
      state: 'active',
      lineup: false,
      costs: { inputPer1M: 0.75, outputPer1M: 3.75, cacheReadPer1M: 0.075 },
      maxTokens: 1048576,
      supportsTools: true,
      supportsCaching: true,
    });
  });

  it('routes: each allowlist admits its id and the registry id is its ModelRef — the google ref carries the gemini/ prefix', () => {
    const routes: readonly (readonly [LlmRoute, ModelId])[] = [
      [{ provider: 'anthropic', model: 'claude-haiku-5-5' }, 'anthropic/claude-haiku-5-5'],
      [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, 'anthropic/claude-sonnet-5-5'],
      [{ provider: 'openai', model: 'gpt-6.1-sol' }, 'openai/gpt-6.1-sol'],
      [{ provider: 'google', model: 'gemini-3.8-flash' }, 'gemini/gemini-3.8-flash'],
    ];
    for (const [route, expectedRef] of routes) {
      expect(isValidLlmRoute(route.provider, route.model), `${route.provider}:${route.model}`).toBe(true);
      const ref = modelRefOfRoute(route);
      expect(ref).toBe(expectedRef);
      if (!isModelId(ref)) throw new Error(`${ref} is not a registry ModelId`);
      expect(isLineupModel(ref)).toBe(ref === 'anthropic/claude-haiku-5-5');
    }
  });

  /**
   * The switch, after the measurement (ggui#1743 stage 1, 2026-10-10, benchmark's
   * receipt on the row: same session, the nightly's ten prompts, n = 3 per arm,
   * judge panel fixed, bars written before the run — panel score +3.07 with a
   * one-sided 95 % lower bound of +0.88 against a −2.5 bar; ≥ 6-turn share 2/30
   * vs 2/30; contract-behaviour failures 2 vs 2; ≈ 0.18× the cost per
   * generation; the one loop it exposed fixed as #1790 and re-measured at
   * 1/1/1 turns). Only the default and its lineup slot move: Sonnet 5.5,
   * GPT-6.1 Sol and Gemini 3.8 Flash stay off the front page, unmeasured.
   */
  it('the measured switch: DEFAULT_MODEL is Haiku 5.5 on the lineup, Haiku 4.5 is legacy and off it, the other three new rows stay off it', () => {
    expect(DEFAULT_MODEL).toBe('anthropic/claude-haiku-5-5');
    expect(MODEL_LINEUP).toContain('anthropic/claude-haiku-5-5');
    expect(MODEL_LINEUP).not.toContain('anthropic/claude-haiku-4-5');
    expect(MODEL_REGISTRY['anthropic/claude-haiku-4-5'].state).toBe('legacy');
    expect(isValidLlmRoute('anthropic', 'claude-haiku-4-5-20251001')).toBe(true); // legacy, still routable
    expect(MODEL_LINEUP).not.toContain('anthropic/claude-sonnet-5-5');
    expect(MODEL_LINEUP).not.toContain('openai/gpt-6.1-sol');
    expect(MODEL_LINEUP).not.toContain('gemini/gemini-3.8-flash');
  });
});
