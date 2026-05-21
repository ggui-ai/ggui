// @ggui-ai/react-native/query — TanStack Query integration (separate entry point)
// Import from '@ggui-ai/react-native/query' to opt in. This keeps
// @tanstack/react-query out of the main bundle for consumers who don't need it.

export { GguiQueryProvider } from './GguiQueryProvider';
export type { GguiQueryProviderProps } from './GguiQueryProvider';
export { useQueryTool, useQueryBindings } from './query-integration';
