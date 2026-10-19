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
  framelessSuppressionRule,
  fillFitRule,
  EXPANDED_FRAME,
  EXPANDED_FRAME_INNER_RADIUS,
  EXPANDED_FRAME_BLEEDS,
  EXPANDED_FRAME_CHROME,
  expandedFrameScrim,
  expandedFrameScrimDecls,
  expandedFramePanelDecls,
  expandedFramePanelRule,
  composeThemeCss,
  toCssDecls,
  CANVAS_CLASSES,
  isCanvasClass,
  GGUI_MOUNT_CANVAS_EXPORT,
  resolveMountFit,
  RADIUS_BUCKETS,
  RADIUS_LADDERS,
  INLINE_CARD_RADIUS_PX,
  INLINE_CARD_RING,
  INLINE_CARD_FRAME_VARS,
  recoverRadiusBucket,
  pxValue,
  inlineCardRadius,
  cardFitRule,
  cardInsetRule,
  mountFitCss,
  FRAMED_CARD_GROUND,
} from './css-tokens';
export type { ComposeThemeCssOptions, ThemeOverlayLayers, CanvasClass, HostDisplayMode, MountFit, RadiusBucket } from './css-tokens';
export {
  rewriteImports,
  buildStaticShimModules,
  findBareImportSpecifiers,
  ASSET_SHIM_FOR_SPECIFIER,
  FORBIDDEN_IMPORT_SPECIFIERS,
  ForbiddenImportSpecifierError,
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
