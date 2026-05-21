/**
 * `@ggui-ai/design/preview` — renderer-owned visual primitives for
 * provisional UI assembly.
 *
 * Scope: visual identity of provisional surfaces. The protocol (which
 * channel, what envelope shape) lives in `@ggui-ai/protocol`; the
 * message schema lives in `@ggui-ai/preview-a2ui`; the A2UI→design
 * mapping + stream consumption live in the renderer packages. This
 * subpath intentionally owns only the pixels.
 *
 * V1 public surface is four components + their keyframe constants:
 *
 *   - `PreviewSurface` — glass/shimmer wrapper + pointer-event block
 *   - `PreviewFragmentEnter` — per-fragment mount animation
 *   - `StreamingText` — optional blinking caret for actively-streaming
 *     text fragments
 *   - `Crossfade` — paired opacity transition from provisional to
 *     final render (wired by consumers; not self-activating)
 *
 * Consumers never need to touch the raw keyframes — they're exported
 * only so tests and downstream renderers can assert on the pin points.
 */
export {
  PREVIEW_KEYFRAMES_STYLE_ID,
  previewCaretKeyframes,
  previewFragmentEnterKeyframes,
  previewKeyframesCss,
  previewReducedMotionCSS,
  previewShimmerKeyframes,
} from './keyframes';

export { PreviewSurface } from './PreviewSurface';
export type { PreviewSurfaceProps } from './PreviewSurface';

export { PreviewFragmentEnter } from './PreviewFragmentEnter';
export type { PreviewFragmentEnterProps } from './PreviewFragmentEnter';

export { StreamingText } from './StreamingText';
export type { StreamingTextProps } from './StreamingText';

export { Crossfade } from './Crossfade';
export type { CrossfadeProps } from './Crossfade';
