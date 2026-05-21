/**
 * Fetch Tool
 *
 * HTTP request tool with caching and response transformation support.
 * React Native has global fetch, so this is a direct port from web.
 */

import type { FetchToolConfig, JsonObject } from '@ggui-ai/protocol';
import { defineTool } from './registry';
import type { ToolContext } from './types';
import { getNestedValue } from './resolver';

/**
 * Simple in-memory cache for fetch results
 */
const cache = new Map<string, { data: unknown; expiresAt: number }>();

function getCached(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }

  return entry.data;
}

function setCache(key: string, data: unknown, ttl: number): void {
  cache.set(key, {
    data,
    expiresAt: Date.now() + ttl,
  });
}

/**
 * Clear cached values.
 *
 * @param sessionId - If provided, only entries for that session are removed.
 *                    If omitted, the entire cache is cleared.
 */
export function clearFetchCache(sessionId?: string): void {
  if (!sessionId) {
    cache.clear();
    return;
  }
  const prefix = `${sessionId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

/**
 * Fetch tool - makes HTTP requests
 */
export const fetchTool = defineTool<FetchToolConfig['config'], unknown>({
  name: 'fetch',
  execute: async (config, context: ToolContext): Promise<unknown> => {
    const {
      endpoint,
      method = 'GET',
      headers = {},
      body,
      cache: cacheConfig,
      extract,
    } = config;

    const baseUrl = context.apiBaseUrl || '';
    const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;

    // Scope cache key by sessionId to prevent cross-session leaks
    const rawCacheKey = cacheConfig?.key || url;
    const cacheKey = context.sessionId ? `${context.sessionId}:${rawCacheKey}` : rawCacheKey;
    if (method === 'GET' && cacheConfig?.ttl) {
      const cached = getCached(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      signal: context.signal,
    };

    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let data: unknown;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    if (extract && typeof data === 'object' && data !== null) {
      data = getNestedValue(data as JsonObject, extract);
    }

    if (method === 'GET' && cacheConfig?.ttl) {
      setCache(cacheKey, data, cacheConfig.ttl);
    }

    return data;
  },
});
