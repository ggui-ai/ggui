import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BlueprintProvider,
  LlmProvider,
} from '@ggui-ai/mcp-server';
import {
  DEFAULT_ROUTE_BY_PROVIDER,
  PROVIDER_PROBE_ORDER,
  describeGenerationBinding,
  probeGenerationBinding,
} from './generation-probe.js';
import type { ByokKeyResolution, ByokResolver } from './byok-resolver.js';

// ─── Fixtures ────────────────────────────────────────────────

const emptyBlueprints: BlueprintProvider = {
  async list() {
    return [];
  },
  async get() {
    return null;
  },
};

/**
 * Build a fake resolver whose `resolve` returns a scripted map of
 * `provider → resolution | null`. Missing entries are treated as
 * `null` (no credentials for that provider).
 */
function makeResolver(
  scripted: Partial<Record<LlmProvider, ByokKeyResolution>>,
): ByokResolver {
  return {
    resolve: async (provider) => scripted[provider] ?? null,
  };
}

// ─── probeGenerationBinding ──────────────────────────────────

describe('probeGenerationBinding', () => {
  let calls: LlmProvider[] = [];

  beforeEach(() => {
    calls = [];
  });

  it('walks the default priority order and resolves on the first hit', async () => {
    const resolver: ByokResolver = {
      resolve: async (provider) => {
        calls.push(provider);
        if (provider === 'openai') {
          return {
            key: 'sk-test',
            source: 'env',
            provider: 'openai',
            envName: 'OPENAI_API_KEY',
          };
        }
        return null;
      },
    };
    const binding = await probeGenerationBinding({
      resolver,
      blueprints: emptyBlueprints,
    });
    expect(binding.bootResolved).toBe(true);
    expect(binding.provider).toBe('openai');
    expect(binding.model).toBe(DEFAULT_ROUTE_BY_PROVIDER.openai.model);
    expect(binding.keySource).toBe('env');
    expect(binding.keyEnvName).toBe('OPENAI_API_KEY');
    // Boot scan halted on the first hit.
    expect(calls).toEqual(['anthropic', 'openai']);
  });

  it('returns a default binding when no provider resolves', async () => {
    const resolver = makeResolver({});
    const binding = await probeGenerationBinding({
      resolver,
      blueprints: emptyBlueprints,
    });
    expect(binding.bootResolved).toBe(false);
    // Default to anthropic / claude-haiku-4-5 — the OSS fall-back
    // provider that the Connect-Claude card flow steers users toward.
    expect(binding.provider).toBe('anthropic');
    expect(binding.model).toBe(DEFAULT_ROUTE_BY_PROVIDER.anthropic.model);
    expect(binding.keySource).toBeUndefined();
    expect(binding.keyEnvName).toBeUndefined();
  });

  it('anthropic wins when present (default priority)', async () => {
    const resolver = makeResolver({
      anthropic: {
        key: 'ant-k',
        source: 'env',
        provider: 'anthropic',
        envName: 'ANTHROPIC_API_KEY',
      },
      openai: {
        key: 'sk',
        source: 'env',
        provider: 'openai',
        envName: 'OPENAI_API_KEY',
      },
    });
    const binding = await probeGenerationBinding({
      resolver,
      blueprints: emptyBlueprints,
    });
    expect(binding.provider).toBe('anthropic');
    expect(binding.model).toBe(DEFAULT_ROUTE_BY_PROVIDER.anthropic.model);
  });

  it('honors a custom providerOrder', async () => {
    const resolver = makeResolver({
      anthropic: {
        key: 'ant-k',
        source: 'env',
        provider: 'anthropic',
        envName: 'ANTHROPIC_API_KEY',
      },
      google: {
        key: 'goog-k',
        source: 'env',
        provider: 'google',
        envName: 'GOOGLE_API_KEY',
      },
    });
    const binding = await probeGenerationBinding({
      resolver,
      blueprints: emptyBlueprints,
      providerOrder: ['google', 'anthropic'],
    });
    expect(binding.provider).toBe('google');
  });

  it('threads the configured blueprints through to GenerationDeps', async () => {
    const blueprints: BlueprintProvider = {
      async list() {
        return [{ id: 'x', name: 'x', source: 'curated', updatedAt: 'now' }];
      },
      async get() {
        return null;
      },
    };
    const resolver = makeResolver({
      anthropic: {
        key: 'ant-k',
        source: 'credentials-file',
        provider: 'anthropic',
      },
    });
    const binding = await probeGenerationBinding({
      resolver,
      blueprints,
    });
    expect(binding.generation.blueprints).toBe(blueprints);
  });

  it('resolveLlm inside GenerationDeps re-resolves with userScope=ctx.appId', async () => {
    const seen: { provider: string; userScope: string | undefined }[] = [];
    const resolver: ByokResolver = {
      resolve: async (provider, opts) => {
        seen.push({ provider, userScope: opts?.userScope });
        if (provider === 'anthropic') {
          return {
            key: 'ant-k',
            source: 'env',
            provider: 'anthropic',
            envName: 'ANTHROPIC_API_KEY',
          };
        }
        return null;
      },
    };
    const binding = await probeGenerationBinding({
      resolver,
      blueprints: emptyBlueprints,
    });
    const creds = await binding.generation.resolveLlm({
      appId: 'user-42',
      requestId: 'r',
    });
    expect(creds).toEqual({
      selection: { provider: 'anthropic', model: DEFAULT_ROUTE_BY_PROVIDER.anthropic.model },
      providerKey: { provider: 'anthropic', key: 'ant-k' },
    });
    // Boot scan called with no userScope; per-call resolveLlm
    // forwards `ctx.appId` as userScope.
    expect(seen.find((c) => c.userScope === 'user-42')).toBeDefined();
  });

  it('resolveLlm returns null when no key resolves at request time', async () => {
    const resolver = makeResolver({});
    const binding = await probeGenerationBinding({
      resolver,
      blueprints: emptyBlueprints,
    });
    const creds = await binding.generation.resolveLlm({
      appId: 'user-42',
      requestId: 'r',
    });
    expect(creds).toBeNull();
  });

  it('threads onNoCredentials onto GenerationDeps', async () => {
    const resolver = makeResolver({});
    const stub = () => null;
    const binding = await probeGenerationBinding({
      resolver,
      blueprints: emptyBlueprints,
      onNoCredentials: stub,
    });
    expect(binding.generation.onNoCredentials).toBe(stub);
  });

  it('keySource is credentials-file when the resolver returns that source', async () => {
    const resolver = makeResolver({
      anthropic: {
        key: 'ant-k',
        source: 'credentials-file',
        provider: 'anthropic',
      },
    });
    const binding = await probeGenerationBinding({
      resolver,
      blueprints: emptyBlueprints,
    });
    expect(binding.keySource).toBe('credentials-file');
    expect(binding.keyEnvName).toBeUndefined();
  });
});

// ─── describeGenerationBinding ───────────────────────────────

describe('describeGenerationBinding', () => {
  const stubGen = {
    uiGenerator: {
      slug: 'ui-gen-default-test',
      tier: 'default' as const,
      model: 'test',
      generate: async () => ({
        ok: false as const,
        error: { code: 'PRODUCTION_FAILED' as const, message: 'n/a' },
      }),
    },
    resolveLlm: () => null,
    blueprints: emptyBlueprints,
  };

  it('renders the no-boot-key fallback line when bootResolved is false', () => {
    const line = describeGenerationBinding({
      generation: stubGen,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      bootResolved: false,
    });
    expect(line).toBe(
      'generation: anthropic / claude-haiku-4-5 (no boot key — per-user fallback)',
    );
  });

  it('renders env variant with env-var name', () => {
    const line = describeGenerationBinding({
      generation: stubGen,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      bootResolved: true,
      keySource: 'env',
      keyEnvName: 'ANTHROPIC_API_KEY',
    });
    expect(line).toBe('generation: anthropic / claude-opus-4-7 (env: ANTHROPIC_API_KEY)');
  });

  it('renders credentials-file variant', () => {
    const line = describeGenerationBinding({
      generation: stubGen,
      provider: 'openai',
      model: 'gpt-4o',
      bootResolved: true,
      keySource: 'credentials-file',
    });
    expect(line).toBe('generation: openai / gpt-4o (credentials-file)');
  });
});

// ─── Locked constants ────────────────────────────────────────

describe('locked constants', () => {
  it('DEFAULT_ROUTE_BY_PROVIDER covers every non-bedrock LlmProvider in PROVIDER_PROBE_ORDER', () => {
    for (const provider of PROVIDER_PROBE_ORDER) {
      const route = DEFAULT_ROUTE_BY_PROVIDER[provider];
      expect(route.provider).toBe(provider);
      expect(route.model).toBeTypeOf('string');
      expect(route.model.length).toBeGreaterThan(0);
    }
  });

  it('PROVIDER_PROBE_ORDER does not include bedrock (hosted-only auth chain)', () => {
    expect(PROVIDER_PROBE_ORDER).not.toContain('bedrock');
  });

  it('PROVIDER_PROBE_ORDER leads with anthropic (OSS ecosystem default)', () => {
    expect(PROVIDER_PROBE_ORDER[0]).toBe('anthropic');
  });
});
