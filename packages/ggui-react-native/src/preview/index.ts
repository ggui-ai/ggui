/**
 * RN analogs of the web `@ggui-ai/design/preview` primitives.
 *
 * Scope mirrors the web subpath — visual identity for provisional
 * UI assembly — but honestly diverges on motion: V1 ships static
 * visuals (tint + `ActivityIndicator` + static caret glyph) rather
 * than fake parity with the web shimmer/caret/crossfade animations.
 * Motion can land in a later dedicated slice without touching the
 * renderer's call sites.
 *
 * Not re-exported from the package root index — consumers reach for
 * these primitives via the dedicated `./preview` path (added to
 * `package.json#exports` alongside this file).
 */
export { PreviewSurface } from './PreviewSurface';
export type { PreviewSurfaceProps } from './PreviewSurface';

export { PreviewFragmentEnter } from './PreviewFragmentEnter';
export type { PreviewFragmentEnterProps } from './PreviewFragmentEnter';

export { StreamingText } from './StreamingText';
export type { StreamingTextProps } from './StreamingText';

export { Crossfade } from './Crossfade';
export type { CrossfadeProps } from './Crossfade';
