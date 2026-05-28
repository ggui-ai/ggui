/**
 * Tool Hooks
 *
 * React hooks for executing client-side tools in controllers.
 * Controllers use these hooks to fetch and transform data.
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
 * Reads appId, sessionId, apiBaseUrl, and auth from the GguiContext
 * provided by GguiProvider. The `resolved` field starts empty and is
 * populated per-tool-call during binding resolution.
 */
function useToolContext(): ToolContext {
  const ctx = useGguiContext();
  return {
    resolved: {},
    appId: ctx.appId,
    // TODO(two-role-sessionId): GguiContext.sessionId is the conversation
    // envelope (hostSessionId-shaped); ToolContext.renderId is render-scoped
    // per Phase B. Pending S4-flagged decision on whether to split or
    // rename GguiContext.sessionId — until then, threading as renderId for
    // typecheck. Cache-scope semantics may need adjustment.
    renderId: ctx.sessionId ?? '',
    auth: ctx.auth ?? { isAuthenticated: false },
    apiBaseUrl: ctx.apiBaseUrl,
  };
}

/**
 * Hook to execute a single tool
 *
 * @example
 * ```tsx
 * function UserProfile({ userId }: { userId: string }) {
 *   const { data, loading, error } = useTool({
 *     config: {
 *       tool: 'fetch',
 *       config: { endpoint: `/api/users/${userId}` }
 *     }
 *   });
 *
 *   if (loading) return <Loading />;
 *   if (error) return <Error error={error} />;
 *   return <Profile user={data} />;
 * }
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

  // Merge context
  const context: ToolContext = useMemo(
    () => ({
      ...baseContext,
      ...contextOverrides,
    }),
    [baseContext, contextOverrides]
  );

  const execute = useCallback(async () => {
    // Cancel any pending request
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

  // Execute on mount and when deps change
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
 * Hook to resolve all data bindings
 *
 * Resolves bindings in topological order based on dependencies.
 * Supports interpolation of resolved values in subsequent bindings.
 *
 * @example
 * ```tsx
 * function Dashboard() {
 *   const { data, loading, errors } = useBindings({
 *     bindings: {
 *       user: { tool: 'auth', config: { field: 'currentUser' } },
 *       profile: {
 *         tool: 'fetch',
 *         config: { endpoint: '/api/users/{user.id}/profile' },
 *         dependsOn: ['user']
 *       }
 *     }
 *   });
 *
 *   if (loading) return <Loading />;
 *   return <DashboardView user={data.user} profile={data.profile} />;
 * }
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

  // Merge context
  const context: ToolContext = useMemo(
    () => ({
      ...baseContext,
      ...contextOverrides,
    }),
    [baseContext, contextOverrides]
  );

  // Stable reference for bindings
  const bindingsJson = JSON.stringify(bindings);

  const execute = useCallback(async () => {
    // Cancel any pending request
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

  // Execute on mount
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
 * Hook to access a specific binding from useBindings result
 *
 * @example
 * ```tsx
 * function UserCard({ bindingsResult, bindingKey }: Props) {
 *   const { data, loading, error } = useBinding(bindingsResult, 'user');
 *   // ...
 * }
 * ```
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
