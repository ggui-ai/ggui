// packages/ui-gen/src/adapters/provider-router.test.ts
//
// Unit tests for `resolveRoute` — the multi-provider routing decision
// at the boundary between `UiGenerateInput` and the per-provider env
// shape that downstream adapters consume.
//
// Pinned shape (the things every caller relies on, regardless of which
// provider routed):
//
//   1. `route.model` — the upstream id the downstream adapter must
//      receive (provider-prefix stripped for direct providers
//      OpenAI + Google; verbatim for indirection providers like
//      OpenRouter; remapped to a Bedrock inference profile for
//      Bedrock).
//   2. `route.env` — the full env mutation block. Crucially this
//      INCLUDES sibling-provider keys cleared to `undefined`, so a
//      stale value from a prior render cannot leak into the next call.
//
// The sibling-clear matrix is load-bearing: a single missing
// `undefined` would let (e.g.) a Bedrock route inherit an
// `OPENAI_API_KEY` set by a preceding OpenAI render, and the wrong
// adapter would silently fire.

import { describe, it, expect } from 'vitest';

import { resolveRoute, type RoutingInput } from './provider-router';

/** Empty env — most tests don't care about the input env. */
const EMPTY_ENV: RoutingInput['env'] = {};

/**
 * Every env-var the resolver is responsible for managing across the
 * supported routes. Used by the sibling-clear matrix to assert no
 * provider's key can survive into another provider's call.
 */
const ALL_MANAGED_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
] as const;

describe('resolveRoute — Anthropic (apiKey present)', () => {
  it('returns the upstream model id and sets ANTHROPIC_API_KEY', () => {
    const route = resolveRoute({
      model: 'anthropic/claude-haiku-4-5',
      apiKey: 'test-key',
      env: EMPTY_ENV,
    });
    // Upstream id strips the `anthropic/` LiteLLM prefix and rewrites
    // to the dated Anthropic API id.
    expect(route.model).toBe('claude-haiku-4-5-20251001');
    expect(route.env.ANTHROPIC_API_KEY).toBe('test-key');
  });

  it('clears every sibling-provider env var', () => {
    const route = resolveRoute({
      model: 'anthropic/claude-haiku-4-5',
      apiKey: 'test-key',
      env: EMPTY_ENV,
    });
    expect(route.env.OPENAI_API_KEY).toBeUndefined();
    expect(route.env.GEMINI_API_KEY).toBeUndefined();
    expect(route.env.GOOGLE_API_KEY).toBeUndefined();
    expect(route.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(route.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });
});

describe('resolveRoute — Bedrock fallback (Anthropic, no apiKey)', () => {
  it('routes to a Bedrock inference profile id and flips CLAUDE_CODE_USE_BEDROCK on', () => {
    const route = resolveRoute({
      model: 'anthropic/claude-haiku-4-5',
      env: EMPTY_ENV,
    });
    expect(route.model).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    );
    expect(route.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
  });

  it('clears every direct-API key so the prior render cannot leak in', () => {
    // This is the load-bearing assertion of the whole file: a single
    // missing `undefined` would let a stale OPENAI_API_KEY from the
    // prior generation slip through and the wrong adapter would fire.
    const route = resolveRoute({
      model: 'anthropic/claude-haiku-4-5',
      env: EMPTY_ENV,
    });
    expect(route.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(route.env.OPENAI_API_KEY).toBeUndefined();
    expect(route.env.GEMINI_API_KEY).toBeUndefined();
    expect(route.env.GOOGLE_API_KEY).toBeUndefined();
    expect(route.env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('explicit CLAUDE_CODE_USE_BEDROCK=1 takes the Bedrock branch even with ANTHROPIC_API_KEY set on env', () => {
    // The `env.CLAUDE_CODE_USE_BEDROCK === '1'` precondition wins over
    // a stale `env.ANTHROPIC_API_KEY` so operator opt-in is honored.
    // Caller-supplied `apiKey` still wins over both (it's the explicit
    // BYOK signal); this test pins the case where ONLY env-level
    // signals are present.
    const route = resolveRoute({
      model: 'anthropic/claude-haiku-4-5',
      env: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_API_KEY: 'stale-from-prior-render',
      },
    });
    expect(route.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(route.model).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    );
  });
});

describe('resolveRoute — OpenAI', () => {
  it('strips the `openai/` prefix and sets OPENAI_API_KEY', () => {
    const route = resolveRoute({
      model: 'openai/gpt-5.4-mini',
      apiKey: 'sk-openai-test',
      env: EMPTY_ENV,
    });
    expect(route.model).toBe('gpt-5.4-mini');
    expect(route.env.OPENAI_API_KEY).toBe('sk-openai-test');
  });

  it('clears every sibling-provider key', () => {
    const route = resolveRoute({
      model: 'openai/gpt-5.4-mini',
      apiKey: 'sk-openai-test',
      env: EMPTY_ENV,
    });
    expect(route.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(route.env.GEMINI_API_KEY).toBeUndefined();
    expect(route.env.GOOGLE_API_KEY).toBeUndefined();
    expect(route.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(route.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('throws an API-key-required error when no apiKey is supplied', () => {
    // OSS Purity: the error MUST NOT mention cloud-only concepts
    // ("platform pool", "pool cache") in any leaf of the message.
    // A self-hoster reading the error must see a fix that works in
    // their deployment (set providerKey.key, or wire their own keys).
    expect(() =>
      resolveRoute({ model: 'openai/gpt-5.4-mini', env: EMPTY_ENV }),
    ).toThrow(/API key/);
    expect(() =>
      resolveRoute({ model: 'openai/gpt-5.4-mini', env: EMPTY_ENV }),
    ).toThrow(/openai\/gpt-5\.4-mini/);
  });
});

describe('resolveRoute — Gemini (Google)', () => {
  it('strips the `google/` prefix and sets BOTH GEMINI_API_KEY and GOOGLE_API_KEY', () => {
    // Google's `@google/genai` SDK accepts the bare model id (e.g.
    // `'gemini-3.5-flash'`); leaving the `google/` prefix on returns
    // 404 from the upstream API. The harness reads either GEMINI_API_KEY
    // or GOOGLE_API_KEY depending on which adapter slot it selects, so
    // both must be set to the same value. Clearing one would leave a
    // stale value across calls.
    const route = resolveRoute({
      model: 'google/gemini-3.5-flash',
      apiKey: 'AIza-test',
      env: EMPTY_ENV,
    });
    expect(route.model).toBe('gemini-3.5-flash');
    expect(route.env.GEMINI_API_KEY).toBe('AIza-test');
    expect(route.env.GOOGLE_API_KEY).toBe('AIza-test');
  });

  it('clears every non-Google sibling key', () => {
    const route = resolveRoute({
      model: 'google/gemini-3.5-flash',
      apiKey: 'AIza-test',
      env: EMPTY_ENV,
    });
    expect(route.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(route.env.OPENAI_API_KEY).toBeUndefined();
    expect(route.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(route.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('throws an API-key-required error when no apiKey is supplied', () => {
    expect(() =>
      resolveRoute({ model: 'google/gemini-3.5-flash', env: EMPTY_ENV }),
    ).toThrow(/API key/);
    expect(() =>
      resolveRoute({ model: 'google/gemini-3.5-flash', env: EMPTY_ENV }),
    ).toThrow(/google\/gemini-3\.5-flash/);
  });
});

describe('resolveRoute — OpenRouter', () => {
  it('passes the full `openrouter/...` model id through verbatim and sets OPENROUTER_API_KEY', () => {
    // OpenRouter's API accepts the full `openrouter/<provider>/<model>`
    // path — DO NOT strip the prefix.
    const route = resolveRoute({
      model: 'openrouter/anthropic/claude-haiku-4-5',
      apiKey: 'sk-or-test',
      env: EMPTY_ENV,
    });
    expect(route.model).toBe('openrouter/anthropic/claude-haiku-4-5');
    expect(route.env.OPENROUTER_API_KEY).toBe('sk-or-test');
  });

  it('clears every sibling-provider key', () => {
    const route = resolveRoute({
      model: 'openrouter/anthropic/claude-haiku-4-5',
      apiKey: 'sk-or-test',
      env: EMPTY_ENV,
    });
    expect(route.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(route.env.OPENAI_API_KEY).toBeUndefined();
    expect(route.env.GEMINI_API_KEY).toBeUndefined();
    expect(route.env.GOOGLE_API_KEY).toBeUndefined();
    expect(route.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('throws an API-key-required error when no apiKey is supplied', () => {
    expect(() =>
      resolveRoute({
        model: 'openrouter/anthropic/claude-haiku-4-5',
        env: EMPTY_ENV,
      }),
    ).toThrow(/API key/);
    expect(() =>
      resolveRoute({
        model: 'openrouter/anthropic/claude-haiku-4-5',
        env: EMPTY_ENV,
      }),
    ).toThrow(/openrouter\/anthropic\/claude-haiku-4-5/);
  });
});

describe('resolveRoute — sibling-clear matrix', () => {
  // Parameterized cross-check: for every supported route, every OTHER
  // provider's env key (or the Bedrock toggle) is set to a literal
  // `undefined`. The point is regression-catching: if a future edit
  // adds a new provider but forgets to clear it in some other route's
  // env block, this matrix catches it.
  type RouteCase = {
    readonly label: string;
    readonly input: RoutingInput;
    /** Keys this route is allowed to set (everything else must be `undefined`). */
    readonly mayPopulate: readonly string[];
  };

  const cases: readonly RouteCase[] = [
    {
      label: 'anthropic-direct (apiKey)',
      input: {
        model: 'anthropic/claude-haiku-4-5',
        apiKey: 'k',
        env: EMPTY_ENV,
      },
      mayPopulate: ['ANTHROPIC_API_KEY'],
    },
    {
      label: 'bedrock fallback (no apiKey)',
      input: { model: 'anthropic/claude-haiku-4-5', env: EMPTY_ENV },
      mayPopulate: ['CLAUDE_CODE_USE_BEDROCK'],
    },
    {
      label: 'openai-direct',
      input: { model: 'openai/gpt-5.4-mini', apiKey: 'k', env: EMPTY_ENV },
      mayPopulate: ['OPENAI_API_KEY'],
    },
    {
      label: 'gemini-direct',
      input: {
        model: 'google/gemini-3.5-flash',
        apiKey: 'k',
        env: EMPTY_ENV,
      },
      // Gemini route legitimately sets BOTH — the harness reads either.
      mayPopulate: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    },
    {
      label: 'openrouter-direct',
      input: {
        model: 'openrouter/anthropic/claude-haiku-4-5',
        apiKey: 'k',
        env: EMPTY_ENV,
      },
      mayPopulate: ['OPENROUTER_API_KEY'],
    },
  ];

  it.each(cases)(
    '$label clears every key it does not own',
    ({ input, mayPopulate }) => {
      const route = resolveRoute(input);
      for (const key of ALL_MANAGED_KEYS) {
        if (mayPopulate.includes(key)) continue;
        // Explicit `undefined` — that's what `applyRouteToEnv`
        // translates into a `delete process.env[key]`. Missing keys
        // would NOT clear stale values from the prior render.
        expect(
          route.env[key],
          `route "${input.model}" must clear sibling key "${key}" (got ${JSON.stringify(route.env[key])})`,
        ).toBeUndefined();
      }
    },
  );
});
