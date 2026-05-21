// packages/ui-gen/src/adapters/registry.ts
//
// Adapter registry — resolves provider + mode to the correct adapter instance.
// Uses dynamic imports so per-provider Lambda bundles only include their own SDKs.
//
// For Lambda deployments, mark non-Claude SDKs as externalModules in esbuild config
// so they're only loaded at runtime when the provider is actually requested.

import type { ProviderName, AdapterMode } from './types';
import type { AnyAdapterConfig } from './base';
import { GeneratorAdapter } from './base';

type AdapterFactory = (config: AnyAdapterConfig) => Promise<GeneratorAdapter>;

const ADAPTER_FACTORIES: Partial<Record<ProviderName, Partial<Record<AdapterMode, AdapterFactory>>>> = {};

function registerProvider(provider: ProviderName, factories: Partial<Record<AdapterMode, AdapterFactory>>): void {
  ADAPTER_FACTORIES[provider] = factories;
}

// Claude
registerProvider('claude', {
  raw: async (config) => {
    const { ClaudeRawAdapter } = await import('./claude/raw');
    return new ClaudeRawAdapter(config);
  },
  sdk: async (config) => {
    const { ClaudeSdkAdapter } = await import('./claude/sdk');
    return new ClaudeSdkAdapter(config);
  },
});

// OpenAI
registerProvider('openai', {
  raw: async (config) => {
    const { OpenAiRawAdapter } = await import('./openai/raw');
    return new OpenAiRawAdapter(config);
  },
  sdk: async (config) => {
    const { OpenAiSdkAdapter } = await import('./openai/sdk');
    return new OpenAiSdkAdapter(config);
  },
});

// Google
registerProvider('google', {
  raw: async (config) => {
    const { GoogleRawAdapter } = await import('./google/raw');
    return new GoogleRawAdapter(config);
  },
  sdk: async (config) => {
    const { GoogleSdkAdapter } = await import('./google/sdk');
    return new GoogleSdkAdapter(config);
  },
});

// OpenRouter (raw only — no Agent SDK)
registerProvider('openrouter', {
  raw: async (config) => {
    const { OpenRouterRawAdapter } = await import('./openrouter/raw');
    return new OpenRouterRawAdapter(config);
  },
});

/**
 * Get an adapter instance for the given provider and mode.
 */
export async function getAdapter(
  provider: ProviderName,
  mode: AdapterMode,
  config: AnyAdapterConfig = {},
): Promise<GeneratorAdapter> {
  const providerFactories = ADAPTER_FACTORIES[provider];
  if (!providerFactories) {
    throw new Error(
      `Unknown provider: ${provider}. Available: ${Object.keys(ADAPTER_FACTORIES).join(', ')}`,
    );
  }

  const factory = providerFactories[mode];
  if (!factory) {
    throw new Error(
      `Unknown mode '${mode}' for provider '${provider}'. Available: ${Object.keys(providerFactories).join(', ')}`,
    );
  }

  return factory(config);
}

/**
 * List all registered adapter combinations and their availability.
 */
export async function listAdapters(
  config: AnyAdapterConfig = {},
): Promise<
  Array<{ provider: ProviderName; mode: AdapterMode; available: boolean; displayName: string }>
> {
  const result: Array<{
    provider: ProviderName;
    mode: AdapterMode;
    available: boolean;
    displayName: string;
  }> = [];

  for (const [provider, modes] of Object.entries(ADAPTER_FACTORIES)) {
    for (const mode of Object.keys(modes)) {
      try {
        const factory = ADAPTER_FACTORIES[provider as ProviderName]?.[mode as AdapterMode];
        if (!factory) continue;
        const adapter = await factory(config);
        result.push({
          provider: provider as ProviderName,
          mode: mode as AdapterMode,
          available: adapter.isAvailable(),
          displayName: adapter.displayName,
        });
      } catch {
        result.push({
          provider: provider as ProviderName,
          mode: mode as AdapterMode,
          available: false,
          displayName: `${provider}/${mode} (not installed)`,
        });
      }
    }
  }

  return result;
}
