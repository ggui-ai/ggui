/**
 * Merge Tool
 *
 * Combine multiple data sources into a single object.
 * Direct port from web SDK.
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
      result[key] = deepMerge(
        result[key] as JsonObject,
        value as JsonObject
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Merge tool - combine multiple data sources
 */
export const mergeTool = defineTool<MergeToolConfig['config'], unknown>({
  name: 'merge',
  execute: async (config, context: ToolContext): Promise<unknown> => {
    const { sources, strategy = 'last', rename } = config;

    if (!sources || sources.length === 0) {
      throw new Error('Merge tool requires at least one source');
    }

    if (rename && Object.keys(rename).length > 0) {
      const result: JsonObject = {};

      for (const source of sources) {
        const value = context.resolved[source];
        const key = rename[source] || source;

        if (strategy === 'first' && key in result) {
          continue;
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

    let result: JsonObject = {};

    for (const source of sources) {
      const value = context.resolved[source];

      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value !== 'object' || Array.isArray(value)) {
        result[source] = value;
        continue;
      }

      const sourceData = value as JsonObject;

      switch (strategy) {
        case 'first':
          for (const [key, val] of Object.entries(sourceData)) {
            if (!(key in result)) {
              result[key] = val;
            }
          }
          break;

        case 'deep':
          result = deepMerge(result, sourceData);
          break;

        case 'last':
        default:
          result = { ...result, ...sourceData };
          break;
      }
    }

    return result;
  },
});
