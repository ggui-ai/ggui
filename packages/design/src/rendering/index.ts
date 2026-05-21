/**
 * Rendering Utilities
 *
 * Shared utilities for ggui rendering contexts (direct React tree, dev-server,
 * serverless). The historic iframe-srcdoc mode was retired alongside the
 * IframeComponentRenderer; all runtime contexts now render inline.
 *
 * @packageDocumentation
 */

export { stripMarkers } from './strip-markers';
export { getCssTokens, getScopedCssTokens, getThemeCss, getScopedThemeCss } from './css-tokens';
export { rewriteImports } from './rewrite-imports';
export type { RewriteOptions, DataUrlOptions, ImportmapOptions } from './rewrite-imports';
// loadModule is browser-only (uses dynamic import()) and is exported via
// @ggui-ai/design/module-loader to avoid pulling it into React Native bundles
// through this barrel. See module-loader.ts for the implementation.
