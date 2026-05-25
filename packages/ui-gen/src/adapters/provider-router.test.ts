// packages/ui-gen/src/adapters/provider-router.test.ts
//
// Unit tests for `resolveRoute` — the multi-provider routing decision
// at the boundary between `UiGenerateInput` (typed `LlmRoute`) and
// the per-provider env shape that downstream adapters consume.
//
// Pinned shape (the things every caller relies on, regardless of which
// provider routed):
//
//   1. `route.model` — the upstream id the downstream adapter must
//      receive. For most routes this is `input.route.model` verbatim
//      (slice #43: typed LlmRoute carries the wire-canonical id at
//      construction time). The mixed-mode "anthropic route + bedrock
//      IAM fallback" branch upcasts via `getBedrockModelId`.
//   2. `route.env` — the full env mutation block. Crucially this
//      INCLUDES sibling-provider keys cleared to `undefined`, so a
//      stale value from a prior render cannot leak into the next call.
//
// The sibling-clear matrix is load-bearing: a single missing
// `undefined` would let (e.g.) a Bedrock route inherit an
// `OPENAI_API_KEY` set by a preceding OpenAI render, and the wrong
// adapter would silently fire.

import { describe, it, expect } from 'vitest';
import type { LlmRoute } from '@ggui-ai/protocol';

import { getBedrockModelId, resolveRoute, type RoutingInput } from './provider-router';

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

const ANT_ROUTE: LlmRoute = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
};
const OAI_ROUTE: LlmRoute = { provider: 'openai', model: 'gpt-5.4-mini' };
const G_ROUTE: LlmRoute = { provider: 'google', model: 'gemini-3.5-flash' };
const OR_ROUTE: LlmRoute = {
  provider: 'openrouter',
  model: 'anthropic/claude-haiku-4.5',
};
const BR_ROUTE: LlmRoute = {
  provider: 'bedrock',
  model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
};

describe('resolveRoute — Anthropic (apiKey present)', () => {
  it('passes the wire-canonical anthropic id verbatim and sets ANTHROPIC_API_KEY', () => {
    const route = resolveRoute({
      route: ANT_ROUTE,
      apiKey: 'test-key',
      env: EMPTY_ENV,
    });
    // Slice #43: typed LlmRoute means no LiteLLM strip needed —
    // `route.model` reaches dispatch verbatim.
    expect(route.model).toBe('claude-haiku-4-5-20251001');
    expect(route.env.ANTHROPIC_API_KEY).toBe('test-key');
  });

  it('clears every sibling-provider env var', () => {
    const route = resolveRoute({
      route: ANT_ROUTE,
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

describe('resolveRoute — Bedrock direct (operator-declared bedrock route)', () => {
  it('passes the cross-region inference profile id verbatim and flips CLAUDE_CODE_USE_BEDROCK on', () => {
    // Slice #43 Phase 4: operators picking bedrock declare it in
    // `ggui.json#generation.model`. The route's model is the full
    // cross-region profile id — no upcast at this boundary.
    const route = resolveRoute({
      route: BR_ROUTE,
      env: EMPTY_ENV,
    });
    expect(route.model).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(route.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
  });

  it('clears every API-key env so prior provider keys cannot leak in', () => {
    const route = resolveRoute({
      route: BR_ROUTE,
      env: EMPTY_ENV,
    });
    expect(route.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(route.env.OPENAI_API_KEY).toBeUndefined();
    expect(route.env.GEMINI_API_KEY).toBeUndefined();
    expect(route.env.GOOGLE_API_KEY).toBeUndefined();
    expect(route.env.OPENROUTER_API_KEY).toBeUndefined();
  });
});

describe('resolveRoute — Anthropic fallback to Bedrock (mixed-mode, cloud-pod legacy)', () => {
  it('upcasts the wire-canonical anthropic id to a Bedrock profile when apiKey is absent + bedrock signal present', () => {
    // The mixed-mode escape hatch: anthropic-typed route + cluster
    // IAM. Cloud-pod uses this when `ANTHROPIC_API_KEY` isn't seeded;
    // OSS Phase 4 strict-fails before reaching this branch.
    const route = resolveRoute({
      route: ANT_ROUTE,
      env: { CLAUDE_CODE_USE_BEDROCK: '1' },
    });
    expect(route.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    // `getBedrockModelId` upcasts the wire-canonical anthropic id.
    expect(route.model).toMatch(/^us\.anthropic\./);
  });

  it('falls back to bedrock when neither apiKey nor ANTHROPIC_API_KEY is set', () => {
    const route = resolveRoute({
      route: ANT_ROUTE,
      env: EMPTY_ENV,
    });
    expect(route.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
  });

  it('explicit CLAUDE_CODE_USE_BEDROCK=1 takes the Bedrock branch even with ANTHROPIC_API_KEY set on env', () => {
    // The `env.CLAUDE_CODE_USE_BEDROCK === '1'` precondition wins over
    // a stale `env.ANTHROPIC_API_KEY` so operator opt-in is honored.
    // Caller-supplied `apiKey` still wins over both.
    const route = resolveRoute({
      route: ANT_ROUTE,
      env: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_API_KEY: 'stale-from-prior-render',
      },
    });
    expect(route.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
  });
});

describe('resolveRoute — OpenAI', () => {
  it('passes the wire-canonical model verbatim and sets OPENAI_API_KEY', () => {
    const route = resolveRoute({
      route: OAI_ROUTE,
      apiKey: 'sk-openai-test',
      env: EMPTY_ENV,
    });
    expect(route.model).toBe('gpt-5.4-mini');
    expect(route.env.OPENAI_API_KEY).toBe('sk-openai-test');
  });

  it('clears every sibling-provider key', () => {
    const route = resolveRoute({
      route: OAI_ROUTE,
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
      resolveRoute({ route: OAI_ROUTE, env: EMPTY_ENV }),
    ).toThrow(/API key/);
    expect(() =>
      resolveRoute({ route: OAI_ROUTE, env: EMPTY_ENV }),
    ).toThrow(/openai:gpt-5\.4-mini/);
  });
});

describe('resolveRoute — Gemini (Google)', () => {
  it('passes the wire-canonical model verbatim and sets BOTH GEMINI_API_KEY and GOOGLE_API_KEY', () => {
    // Google's `@google/genai` SDK accepts the bare model id (e.g.
    // `'gemini-3.5-flash'`). The harness reads either GEMINI_API_KEY
    // or GOOGLE_API_KEY depending on which adapter slot it selects, so
    // both must be set to the same value. Clearing one would leave a
    // stale value across calls.
    const route = resolveRoute({
      route: G_ROUTE,
      apiKey: 'AIza-test',
      env: EMPTY_ENV,
    });
    expect(route.model).toBe('gemini-3.5-flash');
    expect(route.env.GEMINI_API_KEY).toBe('AIza-test');
    expect(route.env.GOOGLE_API_KEY).toBe('AIza-test');
  });

  it('clears every non-Google sibling key', () => {
    const route = resolveRoute({
      route: G_ROUTE,
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
      resolveRoute({ route: G_ROUTE, env: EMPTY_ENV }),
    ).toThrow(/API key/);
    expect(() =>
      resolveRoute({ route: G_ROUTE, env: EMPTY_ENV }),
    ).toThrow(/google:gemini-3\.5-flash/);
  });
});

describe('resolveRoute — OpenRouter', () => {
  it('passes the OpenRouter model id verbatim and sets OPENROUTER_API_KEY', () => {
    // OpenRouter's API accepts the full `<author>/<model>` path —
    // it's already wire-canonical in the typed registry.
    const route = resolveRoute({
      route: OR_ROUTE,
      apiKey: 'sk-or-test',
      env: EMPTY_ENV,
    });
    expect(route.model).toBe('anthropic/claude-haiku-4.5');
    expect(route.env.OPENROUTER_API_KEY).toBe('sk-or-test');
  });

  it('clears every sibling-provider key', () => {
    const route = resolveRoute({
      route: OR_ROUTE,
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
      resolveRoute({ route: OR_ROUTE, env: EMPTY_ENV }),
    ).toThrow(/API key/);
    expect(() =>
      resolveRoute({ route: OR_ROUTE, env: EMPTY_ENV }),
    ).toThrow(/openrouter:anthropic\/claude-haiku-4\.5/);
  });
});

describe('getBedrockModelId — Bedrock opt-in dot form', () => {
  it('upcasts the dot-form short id (anthropic.claude-haiku-4-5) to the cross-region profile', () => {
    // Live-bug regression (cloud e2e 2026-05-25, bedrock-iam.spec): the
    // cloud-pod's `resolvePoolRoute` accepts a `bedrock/<id>` opt-in
    // prefix and strips it before dispatch. For the convenience input
    // `bedrock/anthropic.claude-haiku-4-5`, the stripped form is the
    // dot-shape `anthropic.claude-haiku-4-5`. Pre-fix, this fell through
    // the `^anthropic\/` regex (which only matches the slash form), so
    // the `us.anthropic.` prefix was re-prepended verbatim → the SDK
    // received `us.anthropic.anthropic.claude-haiku-4-5` and Bedrock
    // rejected it with 400 "model identifier is invalid". Test bedrock
    // billing never landed → "balance did NOT drop within 20s" false
    // pricing-miss diagnostic.
    expect(getBedrockModelId('anthropic.claude-haiku-4-5')).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    );
    expect(getBedrockModelId('anthropic.claude-sonnet-4-6')).toBe(
      'us.anthropic.claude-sonnet-4-6',
    );
  });

  it('passes wire-canonical inference-profile ids through verbatim', () => {
    expect(
      getBedrockModelId('us.anthropic.claude-haiku-4-5-20251001-v1:0'),
    ).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('passes ARN forms through verbatim', () => {
    const arn =
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0';
    expect(getBedrockModelId(arn)).toBe(arn);
  });

  it('upcasts the slash form via BEDROCK_MAP (existing behavior)', () => {
    expect(getBedrockModelId('anthropic/claude-haiku-4-5')).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    );
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
      input: { route: ANT_ROUTE, apiKey: 'k', env: EMPTY_ENV },
      mayPopulate: ['ANTHROPIC_API_KEY'],
    },
    {
      label: 'anthropic mixed-mode bedrock fallback (no apiKey)',
      input: { route: ANT_ROUTE, env: EMPTY_ENV },
      mayPopulate: ['CLAUDE_CODE_USE_BEDROCK'],
    },
    {
      label: 'bedrock direct (operator-declared route)',
      input: { route: BR_ROUTE, env: EMPTY_ENV },
      mayPopulate: ['CLAUDE_CODE_USE_BEDROCK'],
    },
    {
      label: 'openai-direct',
      input: { route: OAI_ROUTE, apiKey: 'k', env: EMPTY_ENV },
      mayPopulate: ['OPENAI_API_KEY'],
    },
    {
      label: 'gemini-direct',
      input: { route: G_ROUTE, apiKey: 'k', env: EMPTY_ENV },
      // Gemini route legitimately sets BOTH — the harness reads either.
      mayPopulate: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    },
    {
      label: 'openrouter-direct',
      input: { route: OR_ROUTE, apiKey: 'k', env: EMPTY_ENV },
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
          `route "${input.route.provider}:${input.route.model}" must clear sibling key "${key}" (got ${JSON.stringify(route.env[key])})`,
        ).toBeUndefined();
      }
    },
  );
});
