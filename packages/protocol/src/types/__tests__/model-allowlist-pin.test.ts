/**
 * The allowlist and the registry are ONE list, pinned (ggui#1291).
 *
 * `MODELS[provider]` (llm-route.ts) is what a route may NAME on the wire;
 * `MODEL_REGISTRY` (llm.ts) is what a model IS — display name, tier, state,
 * price. Until this pin, each file called itself the single source of truth
 * and nothing related them: `claude-opus-4-8` was routable for a month with
 * no row (no price, no picker entry), and nothing would have noticed a row
 * no route could reach. The pin runs in BOTH directions, for the DIRECT
 * providers (the vendors' own APIs):
 *
 *   1. allowlist ⊆ rows' wire ids ∪ declared aliases — nothing left over;
 *   2. rows' wire ids ⊆ allowlist — every row is routable;
 *   3. every declared alias is admitted, names a row of its own provider,
 *      and is not itself a row's wire id (an alias of nothing is a phantom).
 *
 * A row's WIRE id is what `parseAnyLlmRoute(id)` yields — the LiteLLM →
 * wire map applies, so `anthropic/claude-haiku-4-5` reads as the dated
 * `claude-haiku-4-5-20251001` here, not as a second spelling.
 *
 * The marketplaces (`bedrock`, `openrouter`) are OUT of the pin on purpose:
 * their ids are other vendors' models under the marketplace's spelling, and
 * each list is curated by its own smoke (see the `MODELS` docblock). The
 * guard below makes that an explicit set, so a new provider fails here until
 * it is classified.
 *
 * Vendor receipts for the dispositions this pin forced, all fetched
 * 2026-10-15:
 *   - platform.claude.com/docs/en/models/opus-4-8: "Model ID: claude-opus-4-8",
 *     "Active (legacy)", "Released May 28, 2026", "Not sooner than May 28,
 *     2027", Input $5 / Output $25 / 5m cache write $6.25 / Cache read $0.50,
 *     "Context window 1M tokens", "Thinking Adaptive". → a ROW.
 *   - developers.openai.com/api/docs/models/gpt-5.5: "Model ID: gpt-5.5",
 *     snapshot "gpt-5.5-2026-04-23" (default), $5 / $0.5 cached / $30,
 *     "1,050,000 context window", function calling supported, Chat
 *     Completions and Responses both "Supported". → a ROW + a SNAPSHOT.
 *   - …/models/gpt-5.5-pro: "Model ID: gpt-5.5-pro", snapshot
 *     "gpt-5.5-pro-2026-04-23" (default), $30 / no cached-input discount /
 *     $180, "1,050,000 context window", function calling supported, Chat
 *     Completions "Not supported" (Responses only — the adapter's concern,
 *     as with gpt-6.1-sol). → a ROW + a SNAPSHOT.
 *   - …/models/gpt-5.6-sol: "The gpt-5.6 alias routes requests to GPT-5.6
 *     Sol." → an ALIAS.
 *   - …/models/gpt-5.4, /gpt-5.4-mini, /gpt-5.4-nano: each page lists ONE
 *     snapshot, the dated id, as "Default snapshot". → SNAPSHOTS.
 *   - ai.google.dev/gemini-api/docs/models: `gemini-3.1-flash-lite-preview`
 *     is under "Previous models" marked "(Shut down)"; `gemini-flash-latest`
 *     appears only as the example of a "-latest" alias that "will get
 *     hot-swapped with every new release", with no stated target. → both
 *     DROPPED from the allowlist (a moving target has no row to be an alias
 *     of; ggui#672's 2026-09-01 ruling already bans "-latest" aliases on the
 *     status probe for the same reason).
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_REGISTRY,
  MODEL_WIRE_ALIASES,
  isModelId,
  type ModelId,
} from '../llm.js';
import {
  MODELS,
  isValidLlmRoute,
  parseAnyLlmRoute,
  type LlmProvider,
} from '../llm-route.js';

const MARKETPLACES = ['bedrock', 'openrouter'] as const satisfies readonly LlmProvider[];
const DIRECT: readonly LlmProvider[] = (Object.keys(MODELS) as LlmProvider[]).filter(
  (p) => !(MARKETPLACES as readonly string[]).includes(p),
);

/** A row's wire id — the model segment of the route its id names. */
function wireIdOf(id: ModelId): string {
  const route = parseAnyLlmRoute(id);
  if (route === null) throw new Error(`registry id ${id} does not parse as a route`);
  return route.model;
}

function rowsOf(provider: LlmProvider): ModelId[] {
  return (Object.keys(MODEL_REGISTRY) as ModelId[]).filter(
    (id) => MODEL_REGISTRY[id].provider === provider,
  );
}

describe('MODELS ↔ MODEL_REGISTRY — one list, pinned both ways (ggui#1291)', () => {
  it('the direct-provider set is every LlmProvider that is not a marketplace', () => {
    expect([...DIRECT].sort()).toEqual(['anthropic', 'google', 'openai']);
  });

  it('every allowlist entry of a direct provider is a row wire id or a declared alias — nothing left over', () => {
    const leftover: string[] = [];
    for (const provider of DIRECT) {
      const wireIds = new Set(rowsOf(provider).map(wireIdOf));
      const aliases = MODEL_WIRE_ALIASES[provider] ?? {};
      for (const entry of MODELS[provider] as readonly string[]) {
        if (!wireIds.has(entry) && !(entry in aliases)) leftover.push(`${provider}:${entry}`);
      }
    }
    expect(leftover).toEqual([]);
  });

  it('every registry row of a direct provider is routable — its wire id is in the allowlist', () => {
    const unroutable: string[] = [];
    for (const provider of DIRECT) {
      for (const id of rowsOf(provider)) {
        if (!isValidLlmRoute(provider, wireIdOf(id))) unroutable.push(id);
      }
    }
    expect(unroutable).toEqual([]);
  });

  it('every declared alias is admitted, names a row of its own provider, and is not itself a row wire id', () => {
    const phantoms: string[] = [];
    for (const provider of Object.keys(MODEL_WIRE_ALIASES) as LlmProvider[]) {
      const wireIds = new Set(rowsOf(provider).map(wireIdOf));
      for (const [alias, target] of Object.entries(MODEL_WIRE_ALIASES[provider] ?? {})) {
        if (!isValidLlmRoute(provider, alias)) phantoms.push(`${provider}:${alias} not admitted`);
        if (!isModelId(target.of) || MODEL_REGISTRY[target.of].provider !== provider) {
          phantoms.push(`${provider}:${alias} → ${target.of} is not a ${provider} row`);
        }
        if (wireIds.has(alias)) phantoms.push(`${provider}:${alias} is a row wire id, not an alias`);
      }
    }
    expect(phantoms).toEqual([]);
  });

  it('the declared aliases are exactly the OpenAI alias + the five dated snapshots (receipts above)', () => {
    expect(MODEL_WIRE_ALIASES).toEqual({
      openai: {
        'gpt-5.6': { of: 'openai/gpt-5.6-sol', kind: 'alias' },
        'gpt-5.5-2026-04-23': { of: 'openai/gpt-5.5', kind: 'snapshot' },
        'gpt-5.5-pro-2026-04-23': { of: 'openai/gpt-5.5-pro', kind: 'snapshot' },
        'gpt-5.4-2026-03-05': { of: 'openai/gpt-5.4', kind: 'snapshot' },
        'gpt-5.4-mini-2026-03-17': { of: 'openai/gpt-5.4-mini', kind: 'snapshot' },
        'gpt-5.4-nano-2026-03-17': { of: 'openai/gpt-5.4-nano', kind: 'snapshot' },
      },
    });
  });
});

describe('the dispositions the pin forced (ggui#1291, receipts fetched 2026-10-15)', () => {
  it('carries anthropic/claude-opus-4-8 exactly as the model page states it: 5 / 25, write 6.25, read 0.5, 1M, legacy, floor 2027-05-28', () => {
    expect(MODEL_REGISTRY['anthropic/claude-opus-4-8']).toEqual({
      id: 'anthropic/claude-opus-4-8',
      provider: 'anthropic',
      displayName: 'Claude Opus 4.8',
      tier: 'premium',
      state: 'legacy',
      lineup: false,
      retireNotBefore: '2027-05-28',
      costs: { inputPer1M: 5.0, outputPer1M: 25.0, cacheWritePer1M: 6.25, cacheReadPer1M: 0.5 },
      maxTokens: 1000000,
      supportsTools: true,
    });
    expect(isValidLlmRoute('anthropic', 'claude-opus-4-8')).toBe(true);
  });

  it('carries openai/gpt-5.5 exactly as its page states it: 5 / 30, cached 0.5, 1,050,000 context, active, not lineup', () => {
    expect(MODEL_REGISTRY['openai/gpt-5.5']).toEqual({
      id: 'openai/gpt-5.5',
      provider: 'openai',
      displayName: 'GPT-5.5',
      tier: 'premium',
      state: 'active',
      lineup: false,
      costs: { inputPer1M: 5.0, outputPer1M: 30.0, cacheReadPer1M: 0.5 },
      maxTokens: 1050000,
      supportsTools: true,
    });
  });

  it('carries openai/gpt-5.5-pro exactly as its page states it: 30 / 180, no cached-input discount, 1,050,000 context, active, not lineup', () => {
    expect(MODEL_REGISTRY['openai/gpt-5.5-pro']).toEqual({
      id: 'openai/gpt-5.5-pro',
      provider: 'openai',
      displayName: 'GPT-5.5 Pro',
      tier: 'premium',
      state: 'active',
      lineup: false,
      costs: { inputPer1M: 30.0, outputPer1M: 180.0 },
      maxTokens: 1050000,
      supportsTools: true,
    });
  });

  it('the two Google ids with no row and no fixed target are no longer admitted; the stable sibling still is (control)', () => {
    expect(isValidLlmRoute('google', 'gemini-3.1-flash-lite-preview')).toBe(false);
    expect(isValidLlmRoute('google', 'gemini-flash-latest')).toBe(false);
    expect(isValidLlmRoute('google', 'gemini-3.1-flash-lite')).toBe(true);
  });
});
