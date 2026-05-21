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
 * Interpolate a string with values from resolved bindings
 *
 * @param template - String with {path.to.value} placeholders
 * @param resolved - Object containing resolved values
 * @returns Interpolated string
 *
 * @example
 * ```ts
 * interpolateString('/api/users/{user.id}', { user: { id: 123 } })
 * // Returns: '/api/users/123'
 * ```
 */
export function interpolateString(
  template: string,
  resolved: JsonObject
): string {
  return template.replace(/\{([^}]+)\}/g, (match, path: string) => {
    const value = getNestedValue(resolved, path);
    if (value === undefined || value === null) {
      // Keep the placeholder if value not found
      return match;
    }
    return String(value);
  });
}

/**
 * Get a nested value from an object using dot notation
 *
 * @example
 * ```ts
 * getNestedValue({ user: { profile: { name: 'Alice' } } }, 'user.profile.name')
 * // Returns: 'Alice'
 *
 * getNestedValue({ prev: { id: 123 } }, 'prev.id')
 * // Returns: 123
 * ```
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
 * placeholders in every string leaf with the corresponding value
 * from `resolved`.
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
 * Resolve all bindings in topological order
 *
 * @param bindings - Data bindings to resolve
 * @param context - Tool execution context
 * @returns Resolved data and any errors
 */
export async function resolveBindings(
  bindings: DataBindings,
  context: ToolContext
): Promise<ResolveResult> {
  const sorted = topologicalSort(bindings);
  const resolved: JsonObject = { ...context.resolved };
  const errors: Record<string, Error | null> = {};

  for (const [key, config] of sorted) {
    // Check for abort
    if (context.signal?.aborted) {
      throw new Error('Binding resolution aborted');
    }

    try {
      // Interpolate config with already-resolved values
      const interpolated = interpolateConfig(config.config, resolved);

      // Execute the tool
      const executor = toolRegistry.getExecutor(config.tool);
      const result = await executor(interpolated, {
        ...context,
        resolved, // Pass resolved values for nested tools
      });

      resolved[key] = result as JsonValue;
      errors[key] = null;
    } catch (err) {
      errors[key] = err instanceof Error ? err : new Error(String(err));
      // Don't stop on error - continue resolving independent bindings
      // Dependent bindings will fail naturally due to missing data
      resolved[key] = null;
    }
  }

  return { data: resolved, errors };
}

/**
 * Validate bindings configuration
 *
 * @param bindings - Bindings to validate
 * @throws Error if bindings are invalid
 */
export function validateBindings(bindings: DataBindings): void {
  // Check for circular dependencies (topologicalSort will throw)
  topologicalSort(bindings);

  // Check that all tools are registered
  for (const [key, config] of Object.entries(bindings)) {
    if (!toolRegistry.has(config.tool)) {
      throw new Error(
        `Binding "${key}" uses unregistered tool "${config.tool}". ` +
          `Available tools: ${toolRegistry.getRegisteredNames().join(', ')}`
      );
    }
  }
}
