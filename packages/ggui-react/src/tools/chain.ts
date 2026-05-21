/**
 * Chain Tool
 *
 * Sequential execution of tools with {prev} interpolation.
 */

import type { ChainToolConfig, ClientToolConfig, JsonValue } from '@ggui-ai/protocol';
import { defineTool, toolRegistry } from './registry';
import { interpolateConfig } from './resolver';
import type { ToolContext } from './types';

/**
 * Chain tool - sequential execution of tools
 *
 * Each step receives the previous step's result as {prev} in interpolation.
 * Steps are executed in order, and the final step's result is returned.
 *
 * @example
 * ```ts
 * // Auth → Fetch → Transform chain
 * {
 *   tool: 'chain',
 *   config: {
 *     steps: [
 *       { tool: 'auth', config: { field: 'currentUser' } },
 *       { tool: 'fetch', config: { endpoint: '/api/dashboard/{prev.id}' } },
 *       { tool: 'transform', config: { pick: ['stats', 'notifications'] } }
 *     ]
 *   }
 * }
 * ```
 *
 * @example
 * ```ts
 * // Multiple fetches with data dependency
 * {
 *   tool: 'chain',
 *   config: {
 *     steps: [
 *       { tool: 'fetch', config: { endpoint: '/api/user' } },
 *       { tool: 'fetch', config: { endpoint: '/api/orders?userId={prev.id}' } }
 *     ]
 *   }
 * }
 * ```
 */
export const chainTool = defineTool<ChainToolConfig['config'], unknown>({
  name: 'chain',
  execute: async (config, context: ToolContext): Promise<unknown> => {
    const { steps } = config;

    if (!steps || steps.length === 0) {
      throw new Error('Chain tool requires at least one step');
    }

    let prev: unknown = null;

    for (let i = 0; i < steps.length; i++) {
      // Check for abort
      if (context.signal?.aborted) {
        throw new Error('Chain execution aborted');
      }

      const step = steps[i] as ClientToolConfig;

      // Interpolate the step config with prev and resolved values
      const interpolated = interpolateConfig(step.config, {
        ...context.resolved,
        prev: prev as JsonValue,
      });

      // Execute the step
      const executor = toolRegistry.getExecutor(step.tool);
      prev = await executor(interpolated, {
        ...context,
        resolved: {
          ...context.resolved,
          prev: prev as JsonValue,
        },
      });
    }

    return prev;
  },
});
