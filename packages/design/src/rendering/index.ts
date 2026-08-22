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
export {
  getCssTokens,
  getScopedCssTokens,
  getThemeCss,
  getScopedThemeCss,
  assembleDeliveredThemeCss,
} from './css-tokens';
export {
  rewriteImports,
  buildStaticShimModules,
  findBareImportSpecifiers,
  ASSET_SHIM_FOR_SPECIFIER,
} from './rewrite-imports';
export type {
  RewriteOptions,
  DataUrlOptions,
  ImportmapOptions,
  AssetUrlOptions,
  StaticShimName,
} from './rewrite-imports';
export {
  resolveInlineSpecifier,
  transformForInlineExec,
  INLINE_EXEC_HANDOFF_GLOBAL,
} from './inline-exec';
export type { InlineExecOptions } from './inline-exec';
// loadModule / loadModuleInline are browser-only and are exported via
// @ggui-ai/design/module-loader to avoid pulling them into React Native
// bundles through this barrel. See module-loader.ts for the implementation.
