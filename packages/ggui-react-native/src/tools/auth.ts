/**
 * Auth Tool
 *
 * Access authentication context data.
 * Direct port from web SDK.
 */

import type { AuthToolConfig, JsonObject } from '@ggui-ai/protocol';
import { defineTool } from './registry';
import type { ToolContext } from './types';

/**
 * Auth tool - access authentication context
 */
export const authTool = defineTool<AuthToolConfig['config'], unknown>({
  name: 'auth',
  execute: async (config, context: ToolContext): Promise<unknown> => {
    const { field } = config;

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
        if (typeof context.auth === 'object' && context.auth !== null) {
          return (context.auth as JsonObject)[field] ?? null;
        }
        throw new Error(`Unknown auth field: ${field}`);
    }
  },
});
