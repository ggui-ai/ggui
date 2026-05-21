/**
 * Chain Tool
 *
 * Sequential execution of tools with {prev} interpolation.
 * Direct port from web SDK.
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
      if (context.signal?.aborted) {
        throw new Error('Chain execution aborted');
      }

      const step = steps[i] as ClientToolConfig;

      const interpolated = interpolateConfig(step.config, {
        ...context.resolved,
        prev: prev as JsonValue,
      });

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
