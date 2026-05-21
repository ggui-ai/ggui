/**
 * PreviewFragmentEnter — entry animation wrapper for newly arriving
 * provisional fragments.
 *
 * Each A2UI `updateComponents` batch may introduce fresh fragments;
 * this component fades them in + lifts them slightly so the assembly
 * reads as a live, staged composition rather than an instant snap.
 *
 * The wrapper is purposefully dumb: one CSS animation, no React state,
 * no orchestration. If a parent remounts the fragment (change of React
 * key), the animation replays — matching how `updateComponents`
 * replace-by-id re-introduces a fragment after reshaping.
 *
 * Reduced-motion is handled by the scoped rules in `./keyframes`
 * (`[data-ggui-preview] *` override), so callers don't need to branch.
 */
import type { CSSProperties, ReactNode } from 'react';

export interface PreviewFragmentEnterProps {
  children: ReactNode;
  /**
   * Fraction of a second to delay before the entry animation begins.
   * Useful when staggering sibling fragments so they don't all pop in
   * at once; callers compute per-fragment delays from their index.
   * Defaults to 0.
   */
  delayMs?: number;
  className?: string;
  style?: CSSProperties;
}

export function PreviewFragmentEnter({
  children,
  delayMs = 0,
  className,
  style,
}: PreviewFragmentEnterProps) {
  const composed: CSSProperties = {
    animation: 'ggui-preview-fragment-enter 220ms cubic-bezier(0, 0, 0.2, 1) both',
    animationDelay: `${Math.max(0, delayMs)}ms`,
    ...style,
  };

  return (
    <div className={className} style={composed}>
      {children}
    </div>
  );
}
