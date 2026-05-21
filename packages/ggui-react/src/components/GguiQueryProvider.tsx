/**
 * Convenience wrapper combining QueryClientProvider + GguiProvider.
 * Provides opt-in TanStack Query caching for the tool system.
 *
 * This component is opt-in — it only loads if @tanstack/react-query is installed.
 *
 * @example
 * ```tsx
 * import { GguiQueryProvider } from '@ggui-ai/react';
 *
 * function App() {
 *   return (
 *     <GguiQueryProvider appId="my-app">
 *       <MyApp />
 *     </GguiQueryProvider>
 *   );
 * }
 * ```
 */
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GguiProvider, type GguiProviderProps } from './GguiProvider';

export interface GguiQueryProviderProps extends GguiProviderProps {
  /** Existing QueryClient instance. If omitted, a default one is created. */
  queryClient?: QueryClient;
}

export function GguiQueryProvider({
  queryClient: externalClient,
  children,
  ...gguiProps
}: GguiQueryProviderProps) {
  const queryClient = useMemo(
    () => externalClient ?? new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          gcTime: 5 * 60_000,
          retry: 1,
        },
      },
    }),
    [externalClient]
  );

  return (
    <QueryClientProvider client={queryClient}>
      <GguiProvider {...gguiProps} queryClient={queryClient}>
        {children}
      </GguiProvider>
    </QueryClientProvider>
  );
}
