/**
 * Merge Tool
 *
 * Combine multiple data sources into a single object.
 */

import type { MergeToolConfig, JsonObject } from '@ggui-ai/protocol';
import { defineTool } from './registry';
import type { ToolContext } from './types';

/**
 * Deep merge two objects
 */
function deepMerge(
  target: JsonObject,
  source: JsonObject
): JsonObject {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      key in result &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      // Deep merge nested objects
      result[key] = deepMerge(
        result[key] as JsonObject,
        value as JsonObject
      );
    } else {
      // Overwrite with source value
      result[key] = value;
    }
  }

  return result;
}

/**
 * Merge tool - combine multiple data sources
 *
 * Merges data from multiple bindings into a single object.
 * Sources must be specified in dependsOn to be resolved first.
 *
 * @example
 * ```ts
 * // Simple merge (last wins)
 * {
 *   tool: 'merge',
 *   config: { sources: ['user', 'profile', 'settings'] },
 *   dependsOn: ['user', 'profile', 'settings']
 * }
 *
 * // First wins
 * {
 *   tool: 'merge',
 *   config: { sources: ['user', 'profile'], strategy: 'first' },
 *   dependsOn: ['user', 'profile']
 * }
 *
 * // Deep merge (recursively merge nested objects)
 * {
 *   tool: 'merge',
 *   config: { sources: ['baseConfig', 'userConfig'], strategy: 'deep' },
 *   dependsOn: ['baseConfig', 'userConfig']
 * }
 *
 * // Rename sources in result
 * {
 *   tool: 'merge',
 *   config: {
 *     sources: ['user', 'notifications'],
 *     rename: { user: 'currentUser', notifications: 'alerts' }
 *   },
 *   dependsOn: ['user', 'notifications']
 * }
 * ```
 */
export const mergeTool = defineTool<MergeToolConfig['config'], unknown>({
  name: 'merge',
  execute: async (config, context: ToolContext): Promise<unknown> => {
    const { sources, strategy = 'last', rename } = config;

    if (!sources || sources.length === 0) {
      throw new Error('Merge tool requires at least one source');
    }

    // If rename is provided but no actual merging, create a renamed object
    if (rename && Object.keys(rename).length > 0) {
      const result: JsonObject = {};

      for (const source of sources) {
        const value = context.resolved[source];
        const key = rename[source] || source;

        if (strategy === 'first' && key in result) {
          continue; // Skip if already exists
        }

        if (strategy === 'deep' && key in result) {
          const existing = result[key];
          if (
            typeof existing === 'object' &&
            existing !== null &&
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(existing) &&
            !Array.isArray(value)
          ) {
            result[key] = deepMerge(
              existing as JsonObject,
              value as JsonObject
            );
            continue;
          }
        }

        result[key] = value;
      }

      return result;
    }

    // Standard merge: flatten all source objects into one
    let result: JsonObject = {};

    for (const source of sources) {
      const value = context.resolved[source];

      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value !== 'object' || Array.isArray(value)) {
        // Non-object values can't be merged, use as-is with source name as key
        result[source] = value;
        continue;
      }

      const sourceData = value as JsonObject;

      switch (strategy) {
        case 'first':
          // Only add fields that don't exist yet
          for (const [key, val] of Object.entries(sourceData)) {
            if (!(key in result)) {
              result[key] = val;
            }
          }
          break;

        case 'deep':
          // Deep merge
          result = deepMerge(result, sourceData);
          break;

        case 'last':
        default:
          // Shallow merge, last wins
          result = { ...result, ...sourceData };
          break;
      }
    }

    return result;
  },
});
