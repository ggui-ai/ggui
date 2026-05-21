/**
 * TanStack Query integration for the tool system.
 * When a QueryClient is available in context, tools use TanStack Query
 * for caching (stale-while-revalidate, persistence, background sync).
 *
 * This module is opt-in — it only loads if @tanstack/react-query is installed.
 */
import { useQuery } from '@tanstack/react-query';
import { toolRegistry } from './registry';
import type {
  ToolContext,
  UseToolReturn,
  UseToolOptions,
  ResolvedBindings,
  UseBindingsOptions,
} from './types';
import type { DataBindings } from '@ggui-ai/protocol';
import { resolveBindings } from './resolver';
import { useGguiContext } from '../context/GguiContext';

/** Generate a stable query key from tool name + config */
function toolQueryKey(toolName: string, config: unknown): unknown[] {
  return ['ggui-tool', toolName, config];
}

/** Generate a stable query key for bindings */
function bindingsQueryKey(bindings: DataBindings): unknown[] {
  return ['ggui-bindings', bindings];
}

/**
 * useTool backed by TanStack Query.
 * Provides stale-while-revalidate, background refetch, and persistence.
 *
 * Drop-in replacement for `useTool` when using `GguiQueryProvider`.
 *
 * @example
 * ```tsx
 * import { useQueryTool } from '@ggui-ai/react';
 *
 * function UserProfile({ userId }: { userId: string }) {
 *   const { data, loading, error } = useQueryTool({
 *     config: {
 *       tool: 'fetch',
 *       config: { endpoint: `/api/users/${userId}` },
 *     },
 *   });
 *
 *   if (loading) return <Loading />;
 *   if (error) return <Error error={error} />;
 *   return <Profile user={data} />;
 * }
 * ```
 */
export function useQueryTool<T = unknown>(options: UseToolOptions): UseToolReturn<T> {
  const { config, context: contextOverrides, skip = false, deps = [] } = options;
  const gguiCtx = useGguiContext();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [...toolQueryKey(config.tool, config.config), ...deps],
    queryFn: async () => {
      const executor = toolRegistry.getExecutor(config.tool);
      return executor(config.config, {
        resolved: {},
        appId: gguiCtx.appId,
        sessionId: '',
        auth: { isAuthenticated: false },
        ...contextOverrides,
      } as ToolContext);
    },
    enabled: !skip,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  return {
    data: (data as T) ?? null,
    loading: isLoading,
    error: error instanceof Error ? error : error ? new Error(String(error)) : null,
    refetch: () => { refetch(); },
    reset: () => { /* TanStack Query manages cache lifecycle internally */ },
  };
}

/**
 * useBindings backed by TanStack Query.
 * Resolves all bindings with TanStack Query caching.
 *
 * Drop-in replacement for `useBindings` when using `GguiQueryProvider`.
 *
 * @example
 * ```tsx
 * import { useQueryBindings } from '@ggui-ai/react';
 *
 * function Dashboard() {
 *   const { data, loading, errors } = useQueryBindings({
 *     bindings: {
 *       user: { tool: 'auth', config: { field: 'currentUser' } },
 *       profile: {
 *         tool: 'fetch',
 *         config: { endpoint: '/api/users/{user.id}/profile' },
 *         dependsOn: ['user'],
 *       },
 *     },
 *   });
 *
 *   if (loading) return <Loading />;
 *   return <DashboardView user={data.user} profile={data.profile} />;
 * }
 * ```
 */
export function useQueryBindings(options: UseBindingsOptions): ResolvedBindings {
  const { bindings, context: contextOverrides, skip = false } = options;
  const gguiCtx = useGguiContext();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: bindingsQueryKey(bindings),
    queryFn: async () => {
      return resolveBindings(bindings, {
        resolved: {},
        appId: gguiCtx.appId,
        sessionId: '',
        auth: { isAuthenticated: false },
        ...contextOverrides,
      } as ToolContext);
    },
    enabled: !skip,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  return {
    data: data?.data ?? {},
    loading: isLoading,
    errors: data?.errors ?? (error ? { _global: error instanceof Error ? error : new Error(String(error)) } : {}),
    refetch: () => { refetch(); },
  };
}
