/**
 * Fetch Tool
 *
 * HTTP request tool with caching and response transformation support.
 */

import type { FetchToolConfig, JsonObject } from '@ggui-ai/protocol';
import { defineTool } from './registry';
import type { ToolContext } from './types';
import { getNestedValue } from './resolver';

/**
 * Simple in-memory cache for fetch results
 */
const cache = new Map<string, { data: unknown; expiresAt: number }>();

/**
 * Get a cached value if still valid
 */
function getCached(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }

  return entry.data;
}

/**
 * Store a value in cache
 */
function setCache(key: string, data: unknown, ttl: number): void {
  cache.set(key, {
    data,
    expiresAt: Date.now() + ttl,
  });
}

/**
 * Clear cached fetch responses.
 *
 * The cache is render-scoped (see {@link fetchTool} — keys are prefixed
 * with `ToolContext.sessionId`). Pass `sessionId` to drop only that render's
 * entries; omit to flush the entire cache.
 *
 * @param sessionId - If provided, only entries scoped to that render are
 *                   removed. If omitted, the entire cache is cleared.
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
 *
 * Features:
 * - Method support (GET, POST, PUT, DELETE, PATCH)
 * - Custom headers
 * - Request body (automatically JSON stringified)
 * - Response caching with TTL
 * - Extract nested data from response
 * - Abort signal support
 *
 * @example
 * ```ts
 * // Simple GET
 * { tool: 'fetch', config: { endpoint: '/api/users' } }
 *
 * // POST with body
 * { tool: 'fetch', config: { endpoint: '/api/users', method: 'POST', body: { name: 'Alice' } } }
 *
 * // With caching
 * { tool: 'fetch', config: { endpoint: '/api/users', cache: { ttl: 60000 } } }
 *
 * // Extract nested data
 * { tool: 'fetch', config: { endpoint: '/api/users', extract: 'data.users' } }
 * ```
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

    // Build full URL
    const baseUrl = context.apiBaseUrl || '';
    const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;

    // Check cache for GET requests — scope by sessionId so two concurrent
    // renders (same app, same fetch key) cannot leak each other's cached
    // responses. The cache is render-scoped, NOT conversation-scoped:
    // distinct renders have distinct fetch caches even within the same
    // host conversation.
    const rawCacheKey = cacheConfig?.key || url;
    const cacheKey = context.sessionId ? `${context.sessionId}:${rawCacheKey}` : rawCacheKey;
    if (method === 'GET' && cacheConfig?.ttl) {
      const cached = getCached(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    // Build fetch options
    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      signal: context.signal,
    };

    // Add body for non-GET requests
    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    // Make the request
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Parse response
    let data: unknown;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    // Extract nested data if specified
    if (extract && typeof data === 'object' && data !== null) {
      data = getNestedValue(data as JsonObject, extract);
    }

    // Cache the result
    if (method === 'GET' && cacheConfig?.ttl) {
      setCache(cacheKey, data, cacheConfig.ttl);
    }

    return data;
  },
});
