/**
 * Transform Tool
 *
 * Data transformation operations: pick, omit, rename, flatten, etc.
 * Direct port from web SDK.
 */

import type { TransformToolConfig, JsonObject, JsonValue } from '@ggui-ai/protocol';
import { defineTool } from './registry';
import type { ToolContext } from './types';
import { getNestedValue } from './resolver';

/**
 * Transform tool - data transformation
 */
export const transformTool = defineTool<TransformToolConfig['config'], unknown>({
  name: 'transform',
  execute: async (config, context: ToolContext): Promise<unknown> => {
    const data = context.resolved.prev ?? {};

    if (typeof data !== 'object' || data === null) {
      return data;
    }

    let result: JsonObject = Array.isArray(data)
      ? Object.fromEntries(data.map((v, i) => [String(i), v]))
      : { ...(data as JsonObject) };

    // Apply flatten first
    if (config.flatten) {
      const nested = getNestedValue(result, config.flatten);
      if (typeof nested === 'object' && nested !== null) {
        const parts = config.flatten.split('.');
        let current: JsonObject = result;
        for (let i = 0; i < parts.length - 1; i++) {
          current = current[parts[i]] as JsonObject;
        }
        delete current[parts[parts.length - 1]];
        result = { ...result, ...(nested as JsonObject) };
      }
    }

    // Apply pick
    if (config.pick && config.pick.length > 0) {
      const picked: JsonObject = {};
      for (const field of config.pick) {
        if (field in result) {
          picked[field] = result[field];
        }
      }
      result = picked;
    }

    // Apply omit
    if (config.omit && config.omit.length > 0) {
      for (const field of config.omit) {
        delete result[field];
      }
    }

    // Apply rename
    if (config.rename) {
      for (const [oldName, newName] of Object.entries(config.rename)) {
        if (oldName in result) {
          result[newName] = result[oldName];
          delete result[oldName];
        }
      }
    }

    // Apply mapArray
    if (config.mapArray) {
      const { field, pick, rename } = config.mapArray;
      const arrayField = field || null;
      const arr = arrayField ? result[arrayField] : result;

      if (Array.isArray(arr)) {
        const mapped = arr.map((item: unknown): JsonValue => {
          if (typeof item !== 'object' || item === null) {
            return item as JsonValue;
          }

          let itemResult: JsonObject = { ...item as JsonObject };

          if (pick && pick.length > 0) {
            const picked: JsonObject = {};
            for (const f of pick) {
              if (f in itemResult) {
                picked[f] = itemResult[f];
              }
            }
            itemResult = picked;
          }

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

    // Apply defaults
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
