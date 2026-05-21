/**
 * Motion Primitives
 *
 * MotionKeyframes — injects CSS @keyframes and reduced-motion styles once.
 * useMotion — hook returning whether motion is enabled.
 * useAnimationKey — returns a key that increments when a dependency changes,
 *                   causing React to remount the element and retrigger CSS animations.
 */

import { useState, useEffect, useRef } from 'react';
import { keyframes, reducedMotionCSS } from '../../tokens/motion';

const STYLE_ID = 'ggui-motion-keyframes';

/**
 * Injects all ggui keyframe definitions and the reduced-motion media query
 * into the document's <head> via a single <style> element.
 *
 * Safe to render multiple times — uses a document.getElementById guard.
 * Returns null (renders nothing visible).
 */
export function MotionKeyframes(): null {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;

    const styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = [
      ...Object.values(keyframes),
      reducedMotionCSS,
    ].join('\n\n');
    document.head.appendChild(styleEl);

    return () => {
      styleEl.remove();
    };
  }, []);

  return null;
}

/**
 * Hook that returns whether motion/animation is currently enabled.
 * Listens for changes to the prefers-reduced-motion media query.
 */
export function useMotion(): { motionEnabled: boolean } {
  const [motionEnabled, setMotionEnabled] = useState(() => {
    if (typeof window === 'undefined') return true;
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setMotionEnabled(!e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return { motionEnabled };
}

/**
 * Returns a key that increments each time `dep` changes, causing React to
 * remount the element and retrigger its CSS animation.
 *
 * Use with state-feedback animations (flash, bounce) where the animation
 * must replay when data updates (e.g., stock price change from a stream).
 *
 * @example
 * ```tsx
 * const priceKey = useAnimationKey(stock.price);
 * <div key={priceKey} style={{ animation: animation.flash, '--ggui-flash-color': 'var(--ggui-color-success-100)' }}>
 *   ${stock.price}
 * </div>
 * ```
 */
export function useAnimationKey(dep: unknown): number {
  const [key, setKey] = useState(0);
  const isFirst = useRef(true);

  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    setKey(k => k + 1);
  }, [dep]);

  return key;
}
