/**
 * CSS keyframes specific to the provisional preview visual language.
 *
 * Kept separate from the general `tokens/motion` keyframe set so the
 * preview surface stays self-contained — consumers who never render a
 * provisional preview don't pay for its keyframes, and we can iterate
 * on the shimmer/caret/crossfade cadence without touching the canonical
 * motion tokens every app already depends on.
 *
 * Injection is handled by `<PreviewSurface>` on first mount via a
 * style-element guard identical to the one used by `<MotionKeyframes>`,
 * so the keyframes reach the document exactly once no matter how many
 * preview surfaces are on screen.
 */

/** Distinct style element id so the guard stays idempotent across renders. */
export const PREVIEW_KEYFRAMES_STYLE_ID = 'ggui-preview-keyframes';

/** Subtle diagonal sheen that sweeps across a `<PreviewSurface>`. */
export const previewShimmerKeyframes = `@keyframes ggui-preview-shimmer {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}`;

/** Blinking caret at the tail of a `<StreamingText streaming>` fragment. */
export const previewCaretKeyframes = `@keyframes ggui-preview-caret {
  0%, 45%  { opacity: 1; }
  55%, 100% { opacity: 0; }
}`;

/**
 * Fragment-entry: scale + fade in. Shares shape with `tokens/motion`'s
 * `scaleIn` but is duplicated here so preview surfaces don't require
 * the main motion stylesheet to be mounted.
 */
export const previewFragmentEnterKeyframes = `@keyframes ggui-preview-fragment-enter {
  from { opacity: 0; transform: scale(0.97); }
  to   { opacity: 1; transform: scale(1); }
}`;

/**
 * Reduced-motion override scoped to the preview namespace only.
 * Leaves the rest of the document's animations untouched — the global
 * `reducedMotionCSS` from `tokens/motion` already covers those and we
 * don't want to inject duplicate rules.
 */
export const previewReducedMotionCSS = `@media (prefers-reduced-motion: reduce) {
  [data-ggui-preview] *,
  [data-ggui-preview]::before,
  [data-ggui-preview]::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}`;

/**
 * Assembled stylesheet injected on first `<PreviewSurface>` mount.
 * Exported as a string so tests can assert on it without reaching into
 * the DOM.
 */
export const previewKeyframesCss = [
  previewShimmerKeyframes,
  previewCaretKeyframes,
  previewFragmentEnterKeyframes,
  previewReducedMotionCSS,
].join('\n\n');
