/**
 * Binding Resolver
 *
 * Resolves data bindings in topological order based on dependencies.
 * Supports interpolation of resolved values in subsequent bindings.
 */

import type { DataBindings, JsonObject, JsonValue, TypedToolConfig } from '@ggui-ai/protocol';
import { toolRegistry } from './registry';
import type { ToolContext } from './types';

/**
 * Result from resolving bindings
 */
export interface ResolveResult {
  data: JsonObject;
  errors: Record<string, Error | null>;
}

/**
 * Topologically sort bindings based on dependsOn relationships
 *
 * @param bindings - Data bindings to sort
 * @returns Array of [key, config] pairs in execution order
 * @throws Error if circular dependency detected
 */
export function topologicalSort(
  bindings: DataBindings
): [string, TypedToolConfig][] {
  const result: [string, TypedToolConfig][] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // For cycle detection

  function visit(key: string): void {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      throw new Error(`Circular dependency detected involving "${key}"`);
    }

    const config = bindings[key];
    if (!config) {
      throw new Error(`Binding "${key}" not found`);
    }

    visiting.add(key);

    // Visit dependencies first
    if (config.dependsOn) {
      for (const dep of config.dependsOn) {
        if (!bindings[dep]) {
          throw new Error(`Binding "${key}" depends on "${dep}" which doesn't exist`);
        }
        visit(dep);
      }
    }

    visiting.delete(key);
    visited.add(key);
    result.push([key, config]);
  }

  // Visit all bindings
  for (const key of Object.keys(bindings)) {
    visit(key);
  }

  return result;
}

/**
 * Interpolate a string with values from resolved bindings.
 *
 * Replaces `{path.to.value}` placeholders with the corresponding value
 * from the `resolved` object. Keeps the placeholder if the value is not found.
 *
 * @param template - String with `{path.to.value}` placeholders
 * @param resolved - Object containing resolved values
 * @returns Interpolated string
 */
export function interpolateString(
  template: string,
  resolved: JsonObject
): string {
  return template.replace(/\{([^}]+)\}/g, (match, path: string) => {
    const value = getNestedValue(resolved, path);
    if (value === undefined || value === null) {
      return match;
    }
    return String(value);
  });
}

/**
 * Get a nested value from an object using dot notation.
 *
 * @param obj - The root object to traverse
 * @param path - Dot-separated path (e.g., `'user.profile.name'`)
 * @returns The value at the path, or `undefined` if not found
 */
export function getNestedValue(obj: JsonObject, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as JsonObject)[part];
  }

  return current;
}

/**
 * Deep-interpolate all string values in a config object.
 *
 * Recursively walks the config tree and replaces `{path.to.value}`
 * placeholders in every string leaf.
 *
 * @typeParam T - The config type (preserved through the transformation)
 * @param config - Configuration object, array, or string to interpolate
 * @param resolved - Object containing resolved binding values
 * @returns The config with all string placeholders replaced
 */
export function interpolateConfig<T>(
  config: T,
  resolved: JsonObject
): T {
  if (typeof config === 'string') {
    return interpolateString(config, resolved) as T;
  }

  if (Array.isArray(config)) {
    return config.map((item) => interpolateConfig(item, resolved)) as T;
  }

  if (config !== null && typeof config === 'object') {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(config)) {
      result[key] = interpolateConfig(value, resolved);
    }
    return result as T;
  }

  return config;
}

/**
 * Resolve all bindings in topological order.
 *
 * Executes each binding's tool with interpolated config, respecting
 * `dependsOn` relationships. Errors on individual bindings do not stop
 * resolution of independent bindings.
 *
 * @param bindings - Data bindings to resolve
 * @param context - Tool execution context (with optional abort signal)
 * @returns Resolved data and any per-binding errors
 */
export async function resolveBindings(
  bindings: DataBindings,
  context: ToolContext
): Promise<ResolveResult> {
  const sorted = topologicalSort(bindings);
  const resolved: JsonObject = { ...context.resolved };
  const errors: Record<string, Error | null> = {};

  for (const [key, config] of sorted) {
    if (context.signal?.aborted) {
      throw new Error('Binding resolution aborted');
    }

    try {
      const interpolated = interpolateConfig(config.config, resolved);
      const executor = toolRegistry.getExecutor(config.tool);
      const result = await executor(interpolated, {
        ...context,
        resolved,
      });

      resolved[key] = result as JsonValue;
      errors[key] = null;
    } catch (err) {
      errors[key] = err instanceof Error ? err : new Error(String(err));
      resolved[key] = null;
    }
  }

  return { data: resolved, errors };
}

/**
 * Validate bindings configuration.
 *
 * Checks for circular dependencies (via topological sort) and verifies
 * all referenced tools are registered.
 *
 * @param bindings - Bindings to validate
 * @throws Error if circular dependency detected or tool is unregistered
 */
export function validateBindings(bindings: DataBindings): void {
  topologicalSort(bindings);

  for (const [key, config] of Object.entries(bindings)) {
    if (!toolRegistry.has(config.tool)) {
      throw new Error(
        `Binding "${key}" uses unregistered tool "${config.tool}". ` +
          `Available tools: ${toolRegistry.getRegisteredNames().join(', ')}`
      );
    }
  }
}
