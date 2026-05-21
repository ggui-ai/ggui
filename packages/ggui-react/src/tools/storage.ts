/**
 * Storage Tool
 *
 * Access localStorage and sessionStorage data.
 */

import type { StorageToolConfig } from '@ggui-ai/protocol';
import { defineTool } from './registry';
import type { ToolContext } from './types';

/**
 * Storage tool - access browser storage
 *
 * Reads from localStorage or sessionStorage.
 *
 * @example
 * ```ts
 * // Read from localStorage
 * { tool: 'storage', config: { key: 'userPrefs' } }
 *
 * // Read from sessionStorage
 * { tool: 'storage', config: { key: 'tempData', storage: 'session' } }
 *
 * // With default value
 * { tool: 'storage', config: { key: 'theme', defaultValue: 'light' } }
 *
 * // Without JSON parsing
 * { tool: 'storage', config: { key: 'rawText', parse: false } }
 * ```
 */
export const storageTool = defineTool<StorageToolConfig['config'], unknown>({
  name: 'storage',
  execute: async (config, _context: ToolContext): Promise<unknown> => {
    const { key, storage = 'local', defaultValue = null, parse = true } = config;

    // Get the appropriate storage object
    const storageObj = storage === 'session' ? sessionStorage : localStorage;

    // Check if storage is available
    if (typeof window === 'undefined' || !storageObj) {
      console.warn(`Storage tool: ${storage}Storage not available`);
      return defaultValue;
    }

    try {
      const value = storageObj.getItem(key);

      if (value === null) {
        return defaultValue;
      }

      if (parse) {
        try {
          return JSON.parse(value);
        } catch {
          // If JSON parsing fails, return as string
          return value;
        }
      }

      return value;
    } catch (err) {
      // Storage access might be blocked (e.g., private browsing)
      console.warn(`Storage tool: Failed to access ${storage}Storage`, err);
      return defaultValue;
    }
  },
});

/**
 * Helper to write to storage (not a tool, but useful for controllers)
 */
export function writeStorage(
  key: string,
  value: unknown,
  storage: 'local' | 'session' = 'local'
): void {
  const storageObj = storage === 'session' ? sessionStorage : localStorage;

  if (typeof window === 'undefined' || !storageObj) {
    console.warn(`writeStorage: ${storage}Storage not available`);
    return;
  }

  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    storageObj.setItem(key, serialized);
  } catch (err) {
    console.warn(`writeStorage: Failed to write to ${storage}Storage`, err);
  }
}

/**
 * Helper to remove from storage
 */
export function removeStorage(key: string, storage: 'local' | 'session' = 'local'): void {
  const storageObj = storage === 'session' ? sessionStorage : localStorage;

  if (typeof window === 'undefined' || !storageObj) {
    return;
  }

  try {
    storageObj.removeItem(key);
  } catch (err) {
    console.warn(`removeStorage: Failed to remove from ${storage}Storage`, err);
  }
}
