/**
 * Transform Tool
 *
 * Data transformation operations: pick, omit, rename, flatten, etc.
 */

import type { TransformToolConfig, JsonObject, JsonValue } from '@ggui-ai/protocol';
import { defineTool } from './registry';
import type { ToolContext } from './types';
import { getNestedValue } from './resolver';

/**
 * Transform tool - data transformation
 *
 * Transforms data by picking, omitting, renaming fields, or flattening nested objects.
 * Designed to work on the previous result in a chain ({prev}).
 *
 * @example
 * ```ts
 * // Pick specific fields
 * { tool: 'transform', config: { pick: ['name', 'email'] } }
 *
 * // Omit sensitive fields
 * { tool: 'transform', config: { omit: ['password', 'ssn'] } }
 *
 * // Rename fields
 * { tool: 'transform', config: { rename: { email: 'contactEmail' } } }
 *
 * // Map array items
 * {
 *   tool: 'transform',
 *   config: {
 *     mapArray: {
 *       field: 'users',
 *       pick: ['id', 'name'],
 *       rename: { name: 'displayName' }
 *     }
 *   }
 * }
 *
 * // Flatten nested object
 * { tool: 'transform', config: { flatten: 'user.profile' } }
 *
 * // Apply defaults
 * { tool: 'transform', config: { defaults: { role: 'user' } } }
 * ```
 */
export const transformTool = defineTool<TransformToolConfig['config'], unknown>({
  name: 'transform',
  execute: async (config, context: ToolContext): Promise<unknown> => {
    // Get the data to transform (from prev in chain)
    const data = context.resolved.prev ?? {};

    // Handle non-object data
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    // Work with a copy — arrays get index-keyed (e.g. { "0": item, "1": item })
    let result: JsonObject = Array.isArray(data)
      ? Object.fromEntries(data.map((v, i) => [String(i), v]))
      : { ...(data as JsonObject) };

    // Apply flatten first (extracts nested object to top level)
    if (config.flatten) {
      const nested = getNestedValue(result, config.flatten);
      if (typeof nested === 'object' && nested !== null) {
        // Remove the nested path from result
        const parts = config.flatten.split('.');
        let current: JsonObject = result;
        for (let i = 0; i < parts.length - 1; i++) {
          current = current[parts[i]] as JsonObject;
        }
        delete current[parts[parts.length - 1]];

        // Merge nested fields into result
        result = { ...result, ...(nested as JsonObject) };
      }
    }

    // Apply pick (keep only specified fields)
    if (config.pick && config.pick.length > 0) {
      const picked: JsonObject = {};
      for (const field of config.pick) {
        if (field in result) {
          picked[field] = result[field];
        }
      }
      result = picked;
    }

    // Apply omit (remove specified fields)
    if (config.omit && config.omit.length > 0) {
      for (const field of config.omit) {
        delete result[field];
      }
    }

    // Apply rename (rename specified fields)
    if (config.rename) {
      for (const [oldName, newName] of Object.entries(config.rename)) {
        if (oldName in result) {
          result[newName] = result[oldName];
          delete result[oldName];
        }
      }
    }

    // Apply mapArray (transform array items)
    if (config.mapArray) {
      const { field, pick, rename } = config.mapArray;
      const arrayField = field || null;

      // Get the array to map
      const arr = arrayField ? result[arrayField] : result;

      if (Array.isArray(arr)) {
        const mapped = arr.map((item: unknown): JsonValue => {
          if (typeof item !== 'object' || item === null) {
            return item as JsonValue;
          }

          let itemResult: JsonObject = { ...item as JsonObject };

          // Pick fields from item
          if (pick && pick.length > 0) {
            const picked: JsonObject = {};
            for (const f of pick) {
              if (f in itemResult) {
                picked[f] = itemResult[f];
              }
            }
            itemResult = picked;
          }

          // Rename fields in item
          if (rename) {
            for (const [oldName, newName] of Object.entries(rename)) {
              if (oldName in itemResult) {
                itemResult[newName] = itemResult[oldName];
                delete itemResult[oldName];
              }
            }
          }

          return itemResult;
        });

        if (arrayField) {
          result[arrayField] = mapped;
        } else {
          return mapped;
        }
      }
    }

    // Apply defaults (fill in missing fields)
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
