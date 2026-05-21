/**
 * Client-side tools for data binding
 *
 * This module provides the tool system that controllers use to fetch and transform data.
 * Tools are registered globally and executed via hooks.
 */

// Types
export type {
  ToolContext,
  ToolExecutor,
  ToolDefinition,
  UseToolReturn,
  UseToolOptions,
  ResolvedBindings,
  UseBindingsOptions,
  ToolResult,
} from './types';

// Registry
export { toolRegistry, registerTool, defineTool } from './registry';

// Hooks
export { useTool, useBindings, useBinding } from './hooks';

// Resolver utilities
export {
  resolveBindings,
  topologicalSort,
  interpolateString,
  interpolateConfig,
  getNestedValue,
  validateBindings,
} from './resolver';

// Built-in tools (auto-registered on import)
export { fetchTool, clearFetchCache } from './fetch';
export { authTool } from './auth';
export { storageTool, writeStorage, removeStorage } from './storage';
export { chainTool } from './chain';
export { transformTool } from './transform';
export { mergeTool } from './merge';

// Re-export protocol types for convenience
export type {
  ClientToolName,
  ClientToolConfig,
  DataBindings,
  TypedToolConfig,
  FetchToolConfig,
  AuthToolConfig,
  StorageToolConfig,
  SubscriptionToolConfig,
  ChainToolConfig,
  TransformToolConfig,
  MergeToolConfig,
} from '@ggui-ai/protocol';
