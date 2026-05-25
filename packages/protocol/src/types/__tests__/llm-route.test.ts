/**
 * Unit tests for the typed `LlmRoute` system.
 *
 * Coverage:
 *   - Provider/model type guards (isLlmProvider, isKnownModel,
 *     isValidOpenrouterModel, isValidLlmRoute)
 *   - Canonical serialization round-trip (serializeLlmRoute / parseLlmRoute)
 *   - LiteLLM back-compat parsing (parseLiteLlmString) including
 *     `<short> → <dated wire id>` mapping for Anthropic Haiku
 *   - LiteLLM forward serialization (toLiteLlmString) including the
 *     inverse short-name mapping
 *   - Combined entry-point parser (parseAnyLlmRoute)
 *   - OpenRouter arbitrary-string escape hatch
 *   - Bedrock multi-region wire identifiers
 *
 * Reference: docs/plans/2026-05-25-llm-route-typed-system.md
 */
import { describe, expect, it } from 'vitest';
import {
  MODELS,
  isKnownModel,
  isLlmProvider,
  isValidLlmRoute,
  isValidOpenrouterModel,
  parseAnyLlmRoute,
  parseLiteLlmString,
  parseLlmRoute,
  serializeLlmRoute,
  toLiteLlmString,
  type LlmRoute,
} from '../llm-route.js';

describe('MODELS registry', () => {
  it('declares every supported provider', () => {
    expect(Object.keys(MODELS).sort()).toEqual(
      ['anthropic', 'bedrock', 'google', 'openai', 'openrouter'].sort(),
    );
  });

  it('every provider has at least one model entry', () => {
    for (const [provider, list] of Object.entries(MODELS)) {
      expect(list.length, `provider ${provider} has zero entries`).toBeGreaterThan(0);
    }
  });

  it('bedrock entries follow the cross-region inference profile shape', () => {
    // `<region>.anthropic.<rest>` — region is one of us/eu/apac/global,
    // payload is anthropic-author and a recognizable claude family.
    for (const id of MODELS.bedrock) {
      expect(id, `bedrock id "${id}"`).toMatch(
        /^(us|eu|apac|global)\.anthropic\.claude-/,
      );
    }
  });

  it('openrouter known entries follow `<author>/<model>` shape', () => {
    for (const id of MODELS.openrouter) {
      expect(id, `openrouter id "${id}"`).toMatch(/^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/);
    }
  });
});

describe('isLlmProvider', () => {
  it('accepts every provider key in MODELS', () => {
    for (const provider of Object.keys(MODELS)) {
      expect(isLlmProvider(provider)).toBe(true);
    }
  });

  it('rejects strings outside the provider enum', () => {
    expect(isLlmProvider('claude')).toBe(false); // product name, not provider
    expect(isLlmProvider('vertex')).toBe(false); // deferred to own slice
    expect(isLlmProvider('ANTHROPIC')).toBe(false); // case-sensitive
    expect(isLlmProvider('')).toBe(false);
  });
});

describe('isKnownModel', () => {
  it('accepts wire-canonical models under their provider', () => {
    expect(isKnownModel('anthropic', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(isKnownModel('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(isKnownModel('openai', 'gpt-5.5')).toBe(true);
    expect(isKnownModel('google', 'gemini-3.5-flash')).toBe(true);
    expect(isKnownModel('bedrock', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true);
  });

  it('rejects models registered under a different provider', () => {
    // claude haiku is registered under anthropic, NOT under bedrock as-is
    expect(isKnownModel('bedrock', 'claude-haiku-4-5-20251001')).toBe(false);
    // gemini is under google, not openai
    expect(isKnownModel('openai', 'gemini-3.5-flash')).toBe(false);
  });

  it('rejects models not in any registry', () => {
    expect(isKnownModel('anthropic', 'claude-completely-made-up')).toBe(false);
  });
});

describe('isValidOpenrouterModel', () => {
  it('accepts `<author>/<model>` shapes', () => {
    expect(isValidOpenrouterModel('anthropic/claude-haiku-4.5')).toBe(true);
    expect(isValidOpenrouterModel('meta-llama/llama-3.3-70b-instruct')).toBe(true);
    expect(isValidOpenrouterModel('x-ai/grok-4.3')).toBe(true);
    expect(isValidOpenrouterModel('qwen/qwen3.7-max')).toBe(true);
  });

  it('rejects strings without exactly one slash', () => {
    expect(isValidOpenrouterModel('no-slash')).toBe(false);
    expect(isValidOpenrouterModel('too/many/slashes')).toBe(false);
    expect(isValidOpenrouterModel('/leading-slash')).toBe(false);
    expect(isValidOpenrouterModel('trailing-slash/')).toBe(false);
    expect(isValidOpenrouterModel('')).toBe(false);
  });

  it('rejects strings with disallowed characters', () => {
    expect(isValidOpenrouterModel('author/model with space')).toBe(false);
    expect(isValidOpenrouterModel('author/model$name')).toBe(false);
  });
});

describe('isValidLlmRoute', () => {
  it('accepts every known (provider, model) pair across the registry', () => {
    for (const [provider, list] of Object.entries(MODELS)) {
      for (const model of list) {
        expect(
          isValidLlmRoute(provider, model),
          `valid pair ${provider}/${model}`,
        ).toBe(true);
      }
    }
  });

  it('accepts arbitrary `<author>/<model>` strings under openrouter', () => {
    expect(isValidLlmRoute('openrouter', 'random-author/random-model')).toBe(true);
    expect(isValidLlmRoute('openrouter', 'cohere/command-r-plus')).toBe(true);
  });

  it('rejects arbitrary strings under non-openrouter providers', () => {
    expect(isValidLlmRoute('anthropic', 'claude-totally-made-up')).toBe(false);
    expect(isValidLlmRoute('google', 'gemini-imaginary')).toBe(false);
  });

  it('rejects unknown providers', () => {
    expect(isValidLlmRoute('vertex', 'gemini-3.5-flash')).toBe(false);
  });
});

describe('serializeLlmRoute / parseLlmRoute — canonical round-trip', () => {
  // Sample of one route per provider, exhaustive coverage of provider
  // branches in serialize / parse.
  const SAMPLES: ReadonlyArray<{ route: LlmRoute; serialized: string }> = [
    {
      route: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      serialized: 'anthropic:claude-haiku-4-5-20251001',
    },
    {
      route: { provider: 'anthropic', model: 'claude-opus-4-7' },
      serialized: 'anthropic:claude-opus-4-7',
    },
    {
      route: { provider: 'openai', model: 'gpt-5.5-2026-04-23' },
      serialized: 'openai:gpt-5.5-2026-04-23',
    },
    {
      route: { provider: 'google', model: 'gemini-3.5-flash' },
      serialized: 'google:gemini-3.5-flash',
    },
    {
      route: {
        provider: 'bedrock',
        model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
      serialized: 'bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0',
    },
    {
      route: { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
      serialized: 'openrouter:anthropic/claude-haiku-4.5',
    },
  ];

  it.each(SAMPLES)('serializes $serialized', ({ route, serialized }) => {
    expect(serializeLlmRoute(route)).toBe(serialized);
  });

  it.each(SAMPLES)('parses $serialized round-trip', ({ route, serialized }) => {
    expect(parseLlmRoute(serialized)).toEqual(route);
  });

  it('returns null when the separator is missing', () => {
    expect(parseLlmRoute('claude-haiku-4-5-20251001')).toBeNull();
    expect(parseLlmRoute('')).toBeNull();
  });

  it('returns null when the model is empty', () => {
    expect(parseLlmRoute('anthropic:')).toBeNull();
  });

  it('returns null when the provider is unknown', () => {
    expect(parseLlmRoute('vertex:gemini-3.5-flash')).toBeNull();
    expect(parseLlmRoute('garbage:anything')).toBeNull();
  });

  it('returns null when the model is unknown under a strict-enum provider', () => {
    expect(parseLlmRoute('anthropic:claude-imaginary')).toBeNull();
  });

  it('accepts arbitrary models for openrouter (escape hatch)', () => {
    const parsed = parseLlmRoute('openrouter:cohere/command-r-plus');
    expect(parsed).toEqual({ provider: 'openrouter', model: 'cohere/command-r-plus' });
  });

  it('rejects malformed openrouter models even with the escape hatch', () => {
    // No slash → not a valid openrouter model shape
    expect(parseLlmRoute('openrouter:just-a-name')).toBeNull();
  });

  it('handles bedrock model strings containing colons (only first `:` is the separator)', () => {
    // Bedrock's wire form contains `:0` in the version suffix. The
    // canonical separator MUST be the first `:`; subsequent colons are
    // part of the model name.
    const serialized = 'bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0';
    const route = parseLlmRoute(serialized);
    expect(route).toEqual({
      provider: 'bedrock',
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    });
  });
});

describe('parseLiteLlmString — back-compat for the historical format', () => {
  it('maps anthropic short → dated wire ID for Haiku', () => {
    expect(parseLiteLlmString('anthropic/claude-haiku-4-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('passes through anthropic 4.6/4.7 short = wire ID', () => {
    // No dated form exists for these — short form IS the wire ID.
    expect(parseLiteLlmString('anthropic/claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(parseLiteLlmString('anthropic/claude-opus-4-7')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
  });

  it('maps `gemini/` → google provider', () => {
    expect(parseLiteLlmString('gemini/gemini-3.5-flash')).toEqual({
      provider: 'google',
      model: 'gemini-3.5-flash',
    });
  });

  it('maps `openai/` → openai provider', () => {
    expect(parseLiteLlmString('openai/gpt-5.5-2026-04-23')).toEqual({
      provider: 'openai',
      model: 'gpt-5.5-2026-04-23',
    });
  });

  it('maps `bedrock/` → bedrock provider (no transformation)', () => {
    expect(
      parseLiteLlmString('bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0'),
    ).toEqual({
      provider: 'bedrock',
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    });
  });

  it('maps `openrouter/<author>/<model>` → openrouter provider with `<author>/<model>` model', () => {
    // OpenRouter has TWO slashes in the LiteLLM string. The model is
    // everything after the FIRST slash, which itself contains a slash.
    expect(parseLiteLlmString('openrouter/anthropic/claude-haiku-4.5')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
    });
  });

  it('returns null on unknown LiteLLM prefix', () => {
    expect(parseLiteLlmString('vertex_ai/gemini-3.5-flash')).toBeNull(); // deferred
    expect(parseLiteLlmString('cohere/command-r')).toBeNull();
    expect(parseLiteLlmString('plainstring')).toBeNull();
    expect(parseLiteLlmString('')).toBeNull();
  });

  it('returns null on empty model after prefix', () => {
    expect(parseLiteLlmString('anthropic/')).toBeNull();
  });

  it('returns null when the mapped model is unknown under the provider', () => {
    // `anthropic/claude-imaginary` has no LiteLLM mapping AND is not
    // a wire-canonical model — should fall through to null.
    expect(parseLiteLlmString('anthropic/claude-imaginary')).toBeNull();
  });
});

describe('toLiteLlmString — forward serialization for observability', () => {
  it('maps anthropic dated wire ID back to LiteLLM short form for Haiku', () => {
    expect(
      toLiteLlmString({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
    ).toBe('anthropic/claude-haiku-4-5');
  });

  it('uses wire ID as-is for anthropic 4.6/4.7 (no inverse mapping needed)', () => {
    expect(
      toLiteLlmString({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    ).toBe('anthropic/claude-sonnet-4-6');
  });

  it('uses `gemini/` prefix for google provider', () => {
    expect(
      toLiteLlmString({ provider: 'google', model: 'gemini-3.5-flash' }),
    ).toBe('gemini/gemini-3.5-flash');
  });

  it('uses `openai/` prefix for openai provider', () => {
    expect(
      toLiteLlmString({ provider: 'openai', model: 'gpt-5.5-2026-04-23' }),
    ).toBe('openai/gpt-5.5-2026-04-23');
  });

  it('uses `bedrock/` prefix for bedrock provider', () => {
    expect(
      toLiteLlmString({
        provider: 'bedrock',
        model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      }),
    ).toBe('bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('uses `openrouter/` prefix for openrouter provider', () => {
    expect(
      toLiteLlmString({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }),
    ).toBe('openrouter/anthropic/claude-haiku-4.5');
  });
});

describe('parseAnyLlmRoute — combined parser', () => {
  it('parses canonical `provider:model` form', () => {
    expect(parseAnyLlmRoute('anthropic:claude-haiku-4-5-20251001')).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('falls back to LiteLLM `prefix/model` form', () => {
    expect(parseAnyLlmRoute('anthropic/claude-haiku-4-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
    expect(parseAnyLlmRoute('gemini/gemini-3.5-flash')).toEqual({
      provider: 'google',
      model: 'gemini-3.5-flash',
    });
  });

  it('returns null when neither format parses', () => {
    expect(parseAnyLlmRoute('garbage')).toBeNull();
    expect(parseAnyLlmRoute('vertex:gemini-3.5-flash')).toBeNull();
    expect(parseAnyLlmRoute('')).toBeNull();
  });

  it('prefers canonical over LiteLLM when both could match (no real ambiguity but worth pinning)', () => {
    // `openai:gpt-5.5` parses as canonical {openai, gpt-5.5}.
    // `openai/gpt-5.5` would parse as LiteLLM → same {openai, gpt-5.5}.
    // Both forms produce the same route in this case — pin equivalence.
    const canonical = parseAnyLlmRoute('openai:gpt-5.5');
    const litellm = parseAnyLlmRoute('openai/gpt-5.5');
    expect(canonical).toEqual(litellm);
    expect(canonical).toEqual({ provider: 'openai', model: 'gpt-5.5' });
  });
});

describe('regression: #22 + #42 (the bug class this slice eliminates)', () => {
  it('#22: gemini/gemini-3.5-flash canonical-form roundtrip yields the bare wire model', () => {
    // Bug was: published rc.1 cli sent `google/gemini-3.5-flash` to
    // Gemini API → 404. With typed routes, the LiteLLM-form parser
    // unambiguously produces `{provider: 'google', model: 'gemini-3.5-flash'}`
    // and the dispatch sends `route.model` (bare wire form) verbatim.
    const route = parseAnyLlmRoute('gemini/gemini-3.5-flash');
    expect(route).toEqual({ provider: 'google', model: 'gemini-3.5-flash' });
    // The model that would be sent to the Gemini API is `route.model`,
    // which is the bare wire form. No transformation, no prefix.
    expect(route?.model).toBe('gemini-3.5-flash');
    expect(route?.model.includes('/')).toBe(false);
  });

  it('#42: anthropic/claude-haiku-4-5 canonical-form roundtrip yields the dated wire ID', () => {
    // Bug was: mcp-server negotiator sent `anthropic/claude-haiku-4-5`
    // to Anthropic API → 404. With typed routes, parsing the LiteLLM
    // form maps to the dated wire ID; dispatch sends `route.model`
    // verbatim with no transformation.
    const route = parseAnyLlmRoute('anthropic/claude-haiku-4-5');
    expect(route).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
    // The model that would be sent to api.anthropic.com is `route.model`,
    // which is the dated wire ID. No prefix, no transformation.
    expect(route?.model).toBe('claude-haiku-4-5-20251001');
    expect(route?.model.includes('/')).toBe(false);
  });
});
