/**
 * Tool execution types for the ggui-react-native client-side tool system
 */

import type {
  ClientToolName,
  ClientToolConfig,
  DataBindings,
  JsonObject,
  ToolContext as SharedToolContext,
  ToolResult,
} from '@ggui-ai/protocol';

/**
 * Extended tool context with React Native-specific additions
 */
export interface ToolContext extends SharedToolContext {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Tool executor function signature
 */
export type ToolExecutor<TConfig = JsonObject, TResult = unknown> = (
  config: TConfig,
  context: ToolContext
) => Promise<TResult>;

/**
 * Tool definition for registration
 */
export interface ToolDefinition<TConfig = JsonObject, TResult = unknown> {
  name: ClientToolName;
  execute: ToolExecutor<TConfig, TResult>;
}

/**
 * Hook return type for useTool
 */
export interface UseToolReturn<T = unknown> extends ToolResult<T> {
  /** Refetch the data */
  refetch: () => void;
  /** Reset to initial state */
  reset: () => void;
}

/**
 * Options for useTool hook
 */
export interface UseToolOptions<TConfig extends ClientToolConfig = ClientToolConfig> {
  /** Tool configuration */
  config: TConfig;
  /** Context overrides */
  context?: Partial<ToolContext>;
  /** Skip initial execution */
  skip?: boolean;
  /** Dependencies that trigger re-fetch when changed */
  deps?: unknown[];
}

/**
 * Result from resolving all bindings
 */
export interface ResolvedBindings {
  /** Resolved data keyed by binding name */
  data: JsonObject;
  /** Overall loading state */
  loading: boolean;
  /** Errors keyed by binding name */
  errors: Record<string, Error | null>;
  /** Refetch all bindings */
  refetch: () => void;
}

/**
 * Options for useBindings hook
 */
export interface UseBindingsOptions {
  /** Data bindings to resolve */
  bindings: DataBindings;
  /** Context overrides */
  context?: Partial<ToolContext>;
  /** Skip initial execution */
  skip?: boolean;
}

export { ToolResult };
