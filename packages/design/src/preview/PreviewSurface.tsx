/**
 * PreviewSurface — visual wrapper for provisional UI assembly.
 *
 * The surface establishes the "this is being built right now" identity:
 * frosted tint, slow shimmer sweep, `cursor: progress` on the root, and
 * `pointer-events: none` on descendants so stray clicks during assembly
 * aren't routed anywhere surprising. Anything rendered inside — typically
 * a tree of A2UI-mapped design primitives — inherits the treatment
 * automatically.
 *
 * Reduced-motion is respected via the scoped CSS media query in
 * `./keyframes`. The shimmer simply freezes; everything else keeps
 * rendering.
 *
 * The wrapper also emits `data-ggui-preview` so the CSS rules in
 * `previewReducedMotionCSS` can target it without relying on class
 * names the consumer might override.
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import {
  PREVIEW_KEYFRAMES_STYLE_ID,
  previewKeyframesCss,
} from './keyframes';

/**
 * Idempotent injection. Multiple `<PreviewSurface>` instances on the
 * same page share a single `<style>` element keyed by
 * {@link PREVIEW_KEYFRAMES_STYLE_ID}. No unmount teardown — the
 * stylesheet cost is trivial and racing React trees against each other
 * trying to claim ownership is not worth it.
 */
function ensureKeyframesInjected(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PREVIEW_KEYFRAMES_STYLE_ID)) return;

  const styleEl = document.createElement('style');
  styleEl.id = PREVIEW_KEYFRAMES_STYLE_ID;
  styleEl.textContent = previewKeyframesCss;
  document.head.appendChild(styleEl);
}

export interface PreviewSurfaceProps {
  children?: ReactNode;
  /**
   * When `true`, the shimmer sweep is paused. Useful for the moment
   * just before handoff when the provisional tree is about to be
   * replaced by the final component — a static shimmer reads as
   * "ready" rather than "still thinking".
   */
  frozen?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * Top-level wrapper for any provisional preview subtree. Apply once
 * per preview surface; don't nest.
 */
export function PreviewSurface({
  children,
  frozen = false,
  className,
  style,
}: PreviewSurfaceProps) {
  useEffect(() => {
    ensureKeyframesInjected();
  }, []);

  // Frosted ambient background. Lightly desaturated + slightly cooler
  // than the host theme so the provisional region reads as distinct
  // without overwhelming the surrounding UI. Uses existing design
  // tokens so dark/light themes inherit their respective chroma.
  const rootStyle: CSSProperties = {
    position: 'relative',
    cursor: 'progress',
    backgroundColor: 'var(--ggui-color-surface-subtle, rgba(148, 163, 184, 0.08))',
    borderRadius: 'var(--ggui-shape-radius-md, 8px)',
    overflow: 'hidden',
    // Block pointer events on every descendant so control shells don't
    // respond to clicks during provisional assembly. The surface itself
    // keeps `cursor: progress` so hover feedback is accurate.
    ...style,
  };

  // Shimmer overlay: translucent diagonal gradient sweeping left→right.
  // Applied via a pseudo-element would couple us to a stylesheet; we
  // render an absolute child instead so consumers get proper shadow-
  // DOM-free isolation.
  const shimmerStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    backgroundImage:
      'linear-gradient(110deg, transparent 0%, transparent 40%, rgba(255, 255, 255, 0.22) 50%, transparent 60%, transparent 100%)',
    backgroundSize: '200% 100%',
    animation: frozen
      ? 'none'
      : 'ggui-preview-shimmer 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite',
    pointerEvents: 'none',
    // Above the content so the sheen reads even on dark backgrounds,
    // but transparent enough not to obscure provisional shells.
    mixBlendMode: 'overlay',
  };

  const contentStyle: CSSProperties = {
    position: 'relative',
    // Pointer events blocked for the whole provisional subtree —
    // buttons, inputs, etc. remain visually present but inert.
    pointerEvents: 'none',
  };

  return (
    <div
      data-ggui-preview=""
      data-ggui-preview-frozen={frozen ? '' : undefined}
      className={className}
      style={rootStyle}
      aria-busy="true"
    >
      <div style={contentStyle}>{children}</div>
      <div aria-hidden="true" style={shimmerStyle} />
    </div>
  );
}
