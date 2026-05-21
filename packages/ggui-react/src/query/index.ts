// @ggui-ai/react/query — TanStack Query integration (separate entry point)
// Import from '@ggui-ai/react/query' to opt in. This keeps
// @tanstack/react-query out of the main bundle for consumers who don't need it.

export { GguiQueryProvider } from '../components/GguiQueryProvider';
export type { GguiQueryProviderProps } from '../components/GguiQueryProvider';
export { useQueryTool, useQueryBindings } from '../tools/query-integration';
