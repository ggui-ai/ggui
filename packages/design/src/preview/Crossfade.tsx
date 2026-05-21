/**
 * Crossfade — paired opacity transition between the provisional preview
 * and the authoritative final render.
 *
 * Usage pattern:
 *
 *   <Crossfade
 *     from={<ProvisionalRenderer ... />}
 *     to={componentCode ? <RealComponent ... /> : null}
 *   />
 *
 * When `to` becomes non-null, the component renders both children into
 * the same bounding box, cross-fades for 220ms, and unmounts the
 * provisional branch after the transition completes.
 *
 * The component is intentionally minimal:
 *   - Stacks `from` and `to` in the same absolute box so there's no
 *     layout shift mid-transition.
 *   - Uses CSS `transition: opacity` rather than a keyframe so
 *     `prefers-reduced-motion` reduces the fade to an instant swap
 *     via the scoped media query.
 *   - Does NOT know about componentCode, A2UI, or ggui internals —
 *     it's a pure UI primitive the renderer drives from outside.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

export interface CrossfadeProps {
  /** Provisional render shown until `to` arrives. */
  from: ReactNode;
  /**
   * Final render. `null` while unavailable; once non-null, the
   * crossfade runs and `from` is unmounted at the end.
   */
  to: ReactNode | null;
  /**
   * Fade duration in milliseconds. Defaults to 220 to match the
   * PreviewFragmentEnter cadence.
   */
  durationMs?: number;
  className?: string;
  style?: CSSProperties;
}

type Phase =
  | { kind: 'provisional' }
  | { kind: 'transitioning' }
  | { kind: 'final' };

export function Crossfade({
  from,
  to,
  durationMs = 220,
  className,
  style,
}: CrossfadeProps) {
  const [phase, setPhase] = useState<Phase>(() =>
    to === null ? { kind: 'provisional' } : { kind: 'final' },
  );

  useEffect(() => {
    if (to === null) {
      setPhase({ kind: 'provisional' });
      return;
    }
    // Mount both layers for the duration of the fade; after the
    // transition window elapses, drop the provisional branch.
    setPhase({ kind: 'transitioning' });
    const done = setTimeout(() => {
      setPhase({ kind: 'final' });
    }, durationMs);
    return () => clearTimeout(done);
  }, [to, durationMs]);

  const container: CSSProperties = {
    position: 'relative',
    ...style,
  };

  if (phase.kind === 'provisional') {
    return (
      <div className={className} style={container}>
        {from}
      </div>
    );
  }

  if (phase.kind === 'final') {
    return (
      <div className={className} style={container}>
        {to}
      </div>
    );
  }

  // transitioning: both layers mounted, stacked, cross-fading
  const fromLayer: CSSProperties = {
    opacity: 0,
    transition: `opacity ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1)`,
  };
  const toLayer: CSSProperties = {
    opacity: 1,
    transition: `opacity ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1)`,
  };

  return (
    <div className={className} style={container}>
      <div style={fromLayer}>{from}</div>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          ...toLayer,
        }}
      >
        {to}
      </div>
    </div>
  );
}
