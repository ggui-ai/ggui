/**
 * Auth Tool
 *
 * Access authentication context data.
 */

import type { AuthToolConfig, JsonObject } from '@ggui-ai/protocol';
import { defineTool } from './registry';
import type { ToolContext } from './types';

/**
 * Auth tool - access authentication context
 *
 * Provides access to the current user and authentication state.
 *
 * Fields:
 * - 'currentUser': Full user object
 * - 'userId': Just the user ID
 * - 'token': Access token
 * - 'isAuthenticated': Boolean authentication state
 *
 * @example
 * ```ts
 * // Get current user
 * { tool: 'auth', config: { field: 'currentUser' } }
 *
 * // Check if authenticated
 * { tool: 'auth', config: { field: 'isAuthenticated' } }
 *
 * // Get access token for API calls
 * { tool: 'auth', config: { field: 'token' } }
 * ```
 */
export const authTool = defineTool<AuthToolConfig['config'], unknown>({
  name: 'auth',
  execute: async (config, context: ToolContext): Promise<unknown> => {
    const { field } = config;

    // Ensure auth context exists
    if (!context.auth) {
      throw new Error('Auth context not available. Ensure GguiProvider is configured with authentication.');
    }

    switch (field) {
      case 'currentUser':
        return context.auth.currentUser ?? null;

      case 'userId':
        return context.auth.userId ?? null;

      case 'token':
        return context.auth.token ?? null;

      case 'isAuthenticated':
        return context.auth.isAuthenticated;

      default:
        // Allow custom fields on the auth context
        if (typeof context.auth === 'object' && context.auth !== null) {
          return (context.auth as JsonObject)[field] ?? null;
        }
        throw new Error(`Unknown auth field: ${field}`);
    }
  },
});
