import { useEffect, useRef, useState } from 'react';

/**
 * Collapse rapid source updates into at most one downstream render per
 * animation frame. Use on streaming content where per-delta re-renders
 * would flicker composer focus or tank framerate.
 *
 * Usage:
 *   const invoke = useInvoke();
 *   const messages = useRafThrottled(invoke.messages);
 */
export function useRafThrottled<T>(source: T): T {
  const [snapshot, setSnapshot] = useState(source);
  const sourceRef = useRef(source);
  const frameRef = useRef<number | null>(null);

  sourceRef.current = source;

  useEffect(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setSnapshot(sourceRef.current);
    });
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [source]);

  return snapshot;
}
