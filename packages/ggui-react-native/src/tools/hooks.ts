/**
 * Tool Hooks
 *
 * React hooks for executing client-side tools in controllers.
 * Controllers use these hooks to fetch and transform data.
 *
 * React Native adaptation: useToolContext reads from GguiContext
 * instead of returning a hardcoded stub.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { DataBindings, JsonObject } from '@ggui-ai/protocol';
import { useGguiContext } from '../context/GguiContext';
import { toolRegistry } from './registry';
import { resolveBindings } from './resolver';
import type {
  ToolContext,
  UseToolReturn,
  UseToolOptions,
  ResolvedBindings,
  UseBindingsOptions,
} from './types';

/**
 * Get tool context from GguiProvider.
 *
 * Reads appId, renderId, apiBaseUrl, and auth from the GguiContext.
 * The `resolved` field starts empty and is populated per-tool-call
 * during binding resolution.
 */
function useToolContext(): ToolContext {
  const ctx = useGguiContext();
  return {
    resolved: {},
    appId: ctx.appId,
    renderId: ctx.renderId ?? '',
    auth: ctx.auth,
    apiBaseUrl: ctx.apiBaseUrl,
  };
}

/**
 * Hook to execute a single client-side tool.
 *
 * Runs the tool on mount (unless `skip` is true) and re-runs when `deps`
 * change. Supports cancellation via AbortController.
 *
 * @typeParam T - Expected result type from the tool execution
 * @param options - Tool configuration, context overrides, and skip/dep controls
 * @returns Data, loading state, error, plus refetch and reset functions
 *
 * @example
 * ```tsx
 * const { data, loading, error } = useTool({
 *   config: { tool: 'fetch', config: { endpoint: '/api/users' } }
 * });
 * ```
 */
export function useTool<T = unknown>(options: UseToolOptions): UseToolReturn<T> {
  const { config, context: contextOverrides, skip = false, deps = [] } = options;
  const baseContext = useToolContext();

  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: Error | null;
  }>({
    data: null,
    loading: !skip,
    error: null,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const context: ToolContext = useMemo(
    () => ({
      ...baseContext,
      ...contextOverrides,
    }),
    [baseContext, contextOverrides]
  );

  const execute = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const executor = toolRegistry.getExecutor(config.tool);
      const result = await executor(config.config, {
        ...context,
        signal: abortController.signal,
      });

      if (mountedRef.current && !abortController.signal.aborted) {
        setState({ data: result as T, loading: false, error: null });
      }
    } catch (err) {
      if (mountedRef.current && !abortControllerRef.current?.signal.aborted) {
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }, [config.tool, config.config, context]);

  const refetch = useCallback(() => {
    execute();
  }, [execute]);

  const reset = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setState({ data: null, loading: false, error: null });
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    if (!skip) {
      execute();
    }

    return () => {
      mountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [skip, ...deps]);

  return {
    ...state,
    refetch,
    reset,
  };
}

/**
 * Hook to resolve all data bindings.
 *
 * Resolves bindings in topological order based on `dependsOn` relationships.
 * Supports interpolation of resolved values in subsequent bindings via
 * `{bindingName.path}` syntax in config strings.
 *
 * @param options - Bindings map, context overrides, and skip control
 * @returns Resolved data map, loading state, per-binding errors, and refetch
 *
 * @example
 * ```tsx
 * const { data, loading, errors } = useBindings({
 *   bindings: {
 *     user: { tool: 'auth', config: { field: 'currentUser' } },
 *     posts: {
 *       tool: 'fetch',
 *       config: { endpoint: '/api/users/{user.id}/posts' },
 *       dependsOn: ['user'],
 *     },
 *   },
 * });
 * ```
 */
export function useBindings(options: UseBindingsOptions): ResolvedBindings {
  const { bindings, context: contextOverrides, skip = false } = options;
  const baseContext = useToolContext();

  const [state, setState] = useState<{
    data: JsonObject;
    loading: boolean;
    errors: Record<string, Error | null>;
  }>({
    data: {},
    loading: !skip,
    errors: {},
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const context: ToolContext = useMemo(
    () => ({
      ...baseContext,
      ...contextOverrides,
    }),
    [baseContext, contextOverrides]
  );

  const bindingsJson = JSON.stringify(bindings);

  const execute = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setState((prev) => ({ ...prev, loading: true }));

    try {
      const parsedBindings: DataBindings = JSON.parse(bindingsJson);
      const result = await resolveBindings(parsedBindings, {
        ...context,
        signal: abortController.signal,
      });

      if (mountedRef.current && !abortController.signal.aborted) {
        setState({
          data: result.data,
          loading: false,
          errors: result.errors,
        });
      }
    } catch (err) {
      if (mountedRef.current && !abortControllerRef.current?.signal.aborted) {
        setState({
          data: {},
          loading: false,
          errors: { _global: err instanceof Error ? err : new Error(String(err)) },
        });
      }
    }
  }, [bindingsJson, context]);

  const refetch = useCallback(() => {
    execute();
  }, [execute]);

  useEffect(() => {
    mountedRef.current = true;

    if (!skip) {
      execute();
    }

    return () => {
      mountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [skip, execute]);

  return {
    ...state,
    refetch,
  };
}

/**
 * Hook to access a specific binding from a {@link useBindings} result.
 *
 * Convenience wrapper that extracts data, loading, and error for a
 * single binding key from the resolved bindings object.
 *
 * @typeParam T - Expected type of the binding's resolved value
 * @param result - The resolved bindings from `useBindings`
 * @param key - The binding key to extract
 * @returns Data, loading state, and error for the specified binding
 */
export function useBinding<T = unknown>(
  result: ResolvedBindings,
  key: string
): { data: T | null; loading: boolean; error: Error | null } {
  return {
    data: (result.data[key] as T) ?? null,
    loading: result.loading,
    error: result.errors[key] ?? null,
  };
}
