/**
 * Tool Registry
 *
 * Central registry for client-side tools. Tools are registered at app startup
 * and used by controllers to fetch and transform data.
 */

import type { ClientToolName, JsonObject } from '@ggui-ai/protocol';
import type { ToolDefinition, ToolExecutor } from './types';

/**
 * Global tool registry singleton
 */
class ToolRegistry {
  private tools = new Map<ClientToolName, ToolDefinition>();

  /**
   * Register a tool
   */
  register<TConfig = JsonObject, TResult = unknown>(
    definition: ToolDefinition<TConfig, TResult>
  ): void {
    this.tools.set(definition.name, definition as ToolDefinition);
  }

  /**
   * Get a tool by name
   */
  get(name: ClientToolName): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get a tool's executor, throwing if not found
   */
  getExecutor(name: ClientToolName): ToolExecutor {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not registered. Available tools: ${this.getRegisteredNames().join(', ')}`);
    }
    return tool.execute;
  }

  /**
   * Check if a tool is registered
   */
  has(name: ClientToolName): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tool names
   */
  getRegisteredNames(): ClientToolName[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Clear all registered tools (mainly for testing)
   */
  clear(): void {
    this.tools.clear();
  }
}

/**
 * Singleton tool registry instance
 */
export const toolRegistry = new ToolRegistry();

/**
 * Helper to register a tool
 */
export function registerTool<TConfig = JsonObject, TResult = unknown>(
  definition: ToolDefinition<TConfig, TResult>
): void {
  toolRegistry.register(definition);
}

/**
 * Decorator-style registration
 *
 * Usage:
 * ```ts
 * const fetchTool = defineTool({
 *   name: 'fetch',
 *   execute: async (config, context) => { ... }
 * });
 * ```
 */
export function defineTool<TConfig = JsonObject, TResult = unknown>(
  definition: ToolDefinition<TConfig, TResult>
): ToolDefinition<TConfig, TResult> {
  toolRegistry.register(definition);
  return definition;
}
