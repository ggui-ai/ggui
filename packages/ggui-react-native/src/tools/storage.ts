/**
 * Storage Tool — React Native Adaptation
 *
 * Uses AsyncStorage instead of localStorage/sessionStorage.
 * The `storage` config field ('local'|'session') is accepted but ignored on RN
 * since there is only a single AsyncStorage backend.
 *
 * Key differences from web:
 * - writeStorage() and removeStorage() return Promise<void> (vs void on web)
 * - All operations are async via AsyncStorage
 */

import type { StorageToolConfig } from '@ggui-ai/protocol';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { defineTool } from './registry';
import type { ToolContext } from './types';

/**
 * Storage tool - access AsyncStorage on React Native
 *
 * The `storage` config field ('local'|'session') is accepted for API
 * compatibility with the web SDK but ignored on React Native.
 */
export const storageTool = defineTool<StorageToolConfig['config'], unknown>({
  name: 'storage',
  execute: async (config, _context: ToolContext): Promise<unknown> => {
    const { key, defaultValue = null, parse = true } = config;

    try {
      const value = await AsyncStorage.getItem(key);

      if (value === null) {
        return defaultValue;
      }

      if (parse) {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }

      return value;
    } catch (err) {
      console.warn('Storage tool: Failed to access AsyncStorage', err);
      return defaultValue;
    }
  },
});

/**
 * Helper to write to AsyncStorage
 *
 * Returns Promise<void> (unlike web which returns void synchronously)
 */
export async function writeStorage(
  key: string,
  value: unknown,
  _storage: 'local' | 'session' = 'local'
): Promise<void> {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await AsyncStorage.setItem(key, serialized);
  } catch (err) {
    console.warn('writeStorage: Failed to write to AsyncStorage', err);
  }
}

/**
 * Helper to remove from AsyncStorage
 *
 * Returns Promise<void> (unlike web which returns void synchronously)
 */
export async function removeStorage(
  key: string,
  _storage: 'local' | 'session' = 'local'
): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch (err) {
    console.warn('removeStorage: Failed to remove from AsyncStorage', err);
  }
}
