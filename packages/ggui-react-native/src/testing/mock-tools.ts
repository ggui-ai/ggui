/**
 * Mock Tools for Testing (React Native SDK)
 *
 * Ported from @ggui-ai/react testing utilities.
 * Provides mock implementations of client-side tools for integration tests.
 */

import type { FetchToolConfig, AuthToolConfig, TransformToolConfig, ChainToolConfig, ClientToolConfig, JsonValue } from '@ggui-ai/protocol';
import { toolRegistry } from '../tools/registry';
import { interpolateConfig } from '../tools/resolver';
import type { ToolContext } from '../tools/types';

export interface MockToolsOptions {
  /** Mock responses for fetch tool: endpoint -> response data */
  fetch?: Record<string, unknown>;
  /** Mock auth context */
  auth?: Record<string, unknown> | null;
  /** Mock storage data: key -> value */
  storage?: Record<string, unknown>;
}

export function setupMockTools(options: MockToolsOptions): void {
  resetMockTools();

  if (options.fetch) {
    registerMockFetch(options.fetch);
  }
  if (options.auth !== undefined) {
    registerMockAuth(options.auth);
  }
  if (options.storage) {
    registerMockStorage(options.storage);
  }

  registerMockTransform();
  registerMockChain();
  registerMockMerge();
}

export function resetMockTools(): void {
  toolRegistry.clear();
}

export function registerMockFetch(responses: Record<string, unknown>): void {
  toolRegistry.register<FetchToolConfig['config'], unknown>({
    name: 'fetch',
    execute: async (config, _context): Promise<unknown> => {
      const { endpoint, extract } = config;

      const response = responses[endpoint];

      if (response === undefined) {
        for (const [pattern, data] of Object.entries(responses)) {
          const regexPattern = pattern.replace(/\{[^}]+\}/g, '[^/]+');
          const regex = new RegExp(`^${regexPattern}$`);
          if (regex.test(endpoint)) {
            if (extract && typeof data === 'object' && data !== null) {
              return getNestedValue(data as Record<string, unknown>, extract);
            }
            return data;
          }
        }
        throw new Error(`Mock fetch: No response defined for endpoint "${endpoint}"`);
      }

      if (extract && typeof response === 'object' && response !== null) {
        return getNestedValue(response as Record<string, unknown>, extract);
      }

      return response;
    },
  });
}

export function registerMockAuth(user: Record<string, unknown> | null): void {
  toolRegistry.register<AuthToolConfig['config'], unknown>({
    name: 'auth',
    execute: async (config): Promise<unknown> => {
      const { field } = config;

      if (!user) {
        if (field === 'isAuthenticated') return false;
        return null;
      }

      switch (field) {
        case 'currentUser':
          return user;
        case 'userId':
          return user.id ?? null;
        case 'token':
          return user.token ?? 'mock-token';
        case 'isAuthenticated':
          return true;
        default:
          return user[field] ?? null;
      }
    },
  });
}

export function registerMockStorage(data: Record<string, unknown>): void {
  toolRegistry.register({
    name: 'storage',
    execute: async (config: { key: string; defaultValue?: unknown }): Promise<unknown> => {
      const { key, defaultValue } = config;
      return data[key] ?? defaultValue ?? null;
    },
  });
}

export function registerMockTransform(): void {
  toolRegistry.register<TransformToolConfig['config'], unknown>({
    name: 'transform',
    execute: async (config, context): Promise<unknown> => {
      const data = context.resolved.prev ?? {};

      if (typeof data !== 'object' || data === null) {
        return data;
      }

      let result: Record<string, unknown> = Array.isArray(data)
        ? ([...data] as unknown as Record<string, unknown>)
        : { ...(data as Record<string, unknown>) };

      if (config.flatten) {
        const nested = getNestedValue(result, config.flatten);
        if (typeof nested === 'object' && nested !== null) {
          const parts = config.flatten.split('.');
          let current: Record<string, unknown> = result;
          for (let i = 0; i < parts.length - 1; i++) {
            current = current[parts[i]] as Record<string, unknown>;
          }
          delete current[parts[parts.length - 1]];
          result = { ...result, ...(nested as Record<string, unknown>) };
        }
      }

      if (config.pick && config.pick.length > 0) {
        const picked: Record<string, unknown> = {};
        for (const field of config.pick) {
          if (field in result) {
            picked[field] = result[field];
          }
        }
        result = picked;
      }

      if (config.omit && config.omit.length > 0) {
        for (const field of config.omit) {
          delete result[field];
        }
      }

      if (config.rename) {
        for (const [oldName, newName] of Object.entries(config.rename)) {
          if (oldName in result) {
            result[newName] = result[oldName];
            delete result[oldName];
          }
        }
      }

      if (config.defaults) {
        for (const [field, defaultValue] of Object.entries(config.defaults)) {
          if (!(field in result) || result[field] === undefined || result[field] === null) {
            result[field] = defaultValue;
          }
        }
      }

      return result;
    },
  });
}

export function registerMockChain(): void {
  toolRegistry.register<ChainToolConfig['config'], unknown>({
    name: 'chain',
    execute: async (config, context): Promise<unknown> => {
      const { steps } = config;

      if (!steps || steps.length === 0) {
        throw new Error('Chain tool requires at least one step');
      }

      let prev: unknown = null;

      for (const step of steps) {
        const stepConfig = step as ClientToolConfig;
        const interpolated = interpolateConfig(stepConfig.config, {
          ...context.resolved,
          prev: prev as JsonValue,
        });

        const executor = toolRegistry.getExecutor(stepConfig.tool);
        prev = await executor(interpolated, {
          ...context,
          resolved: {
            ...context.resolved,
            prev: prev as JsonValue,
          },
        });
      }

      return prev;
    },
  });
}

export function registerMockMerge(): void {
  toolRegistry.register({
    name: 'merge',
    execute: async (
      config: { sources: string[]; strategy?: 'first' | 'last' | 'deep' },
      context: ToolContext,
    ): Promise<unknown> => {
      const { sources, strategy = 'last' } = config;
      let result: Record<string, unknown> = {};

      for (const source of sources) {
        const data = context.resolved[source];
        if (typeof data === 'object' && data !== null) {
          if (strategy === 'deep') {
            result = deepMerge(result, data as Record<string, unknown>);
          } else {
            result = { ...result, ...(data as Record<string, unknown>) };
          }
        }
      }

      return result;
    },
  });
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
