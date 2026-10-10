/**
 * ggui#1793 — ONE zero-config route table, exported beside `DEFAULT_MODEL`.
 *
 * `ggui serve`'s first-run path picks a model from the one provider key an
 * operator exported. That table lived in the CLI and never imported the
 * registry's default, so #1743's default switch missed it until a reader
 * found it by hand. The registry now exports the table; the CLI imports it.
 * Every value here is pinned so a move is a decision with a receipt, and the
 * Anthropic row is DERIVED from `DEFAULT_MODEL` in code, so the two cannot be
 * set apart again.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, MODEL_REGISTRY, ZERO_CONFIG_ROUTE_BY_PROVIDER, isModelId } from '../llm.js';
import {
  MODELS,
  isKnownModel,
  isValidLlmRoute,
  modelRefOfRoute,
  parseAnyLlmRoute,
  type LlmProvider,
} from '../llm-route.js';

const providers = Object.keys(ZERO_CONFIG_ROUTE_BY_PROVIDER).sort() as Exclude<LlmProvider, 'bedrock'>[];

describe('ZERO_CONFIG_ROUTE_BY_PROVIDER (ggui#1793)', () => {
  it('covers every provider the BYOK key probe can resolve — all of MODELS except bedrock, whose credentials flow through the AWS SDK chain', () => {
    const expected = (Object.keys(MODELS) as LlmProvider[]).filter((p) => p !== 'bedrock').sort();
    expect(providers).toEqual(expected);
    expect(providers).not.toContain('bedrock');
  });

  it("the Anthropic route IS the registry's default, derived in code — the two cannot be set apart", () => {
    expect(ZERO_CONFIG_ROUTE_BY_PROVIDER.anthropic).toEqual(parseAnyLlmRoute(DEFAULT_MODEL));
    expect(ZERO_CONFIG_ROUTE_BY_PROVIDER.anthropic).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
  });

  it('every route is a LISTED model (isKnownModel), not merely a well-shaped one — for OpenRouter that means it passed its tools smoke', () => {
    // `isValidLlmRoute('openrouter', …)` is open-world (any `vendor/model` parses), so it is the wrong pin here;
    // `isKnownModel` is the one that fails on an unlisted id (ggui-team-oss, ggui#1792).
    for (const provider of providers) {
      const route = ZERO_CONFIG_ROUTE_BY_PROVIDER[provider];
      expect(route.provider, provider).toBe(provider);
      expect(isKnownModel(route.provider, route.model), `${provider}:${route.model}`).toBe(true);
      expect(isValidLlmRoute(route.provider, route.model), `${provider}:${route.model}`).toBe(true);
    }
    expect(isKnownModel('openrouter', 'anthropic/claude-haiku-9.9')).toBe(false); // the control: unlisted reads false
    expect(isValidLlmRoute('openrouter', 'anthropic/claude-haiku-9.9')).toBe(true); // …while the shape check would pass it
  });

  it('every non-OpenRouter route resolves to an ACTIVE registry row — a legacy or retired model cannot stay a zero-config default by accident', () => {
    for (const provider of providers) {
      if (provider === 'openrouter') continue; // OpenRouter routes are `<author>/<model>` strings, not registry rows
      const ref = modelRefOfRoute(ZERO_CONFIG_ROUTE_BY_PROVIDER[provider]);
      if (!isModelId(ref)) throw new Error(`${provider}: ${ref} is not a registry ModelId`);
      expect(MODEL_REGISTRY[ref].state, ref).toBe('active');
    }
  });

  it('the values are exactly these — a move is a decision with a receipt, never a drift (rnd, ggui#1743 / #1793)', () => {
    expect(ZERO_CONFIG_ROUTE_BY_PROVIDER).toEqual({
      anthropic: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      openai: { provider: 'openai', model: 'gpt-5.6-luna' },
      google: { provider: 'google', model: 'gemini-3.5-flash-lite' },
      openrouter: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
    });
  });
});
