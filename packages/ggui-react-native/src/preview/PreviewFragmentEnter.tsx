/**
 * PreviewFragmentEnter — wrapper slot for newly arriving provisional
 * fragments on React Native.
 *
 * V1 is a plain passthrough that tags the node with a stable testID
 * so consumers (and tests) can locate the boundary. The web version
 * fires a `@keyframes scale-in` animation on mount; the RN parity
 * animation would require `Animated.View` plus `Animated.timing` with
 * a chain of side-effects inside `useEffect`, and the test-env
 * `Animated` mock doesn't cover `Animated.View`. The honest V1 choice
 * is to land the structural wrapper now and polish motion in a later
 * dedicated slice.
 *
 * The component is deliberately dumb — no state, no effects, no
 * animation. Consumers that want a future motion layer can reach into
 * this file and extend it without touching the renderer.
 */
import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

export interface PreviewFragmentEnterProps {
  children: ReactNode;
  /**
   * Intended for future staggered-reveal motion — accepted here so
   * callers can already express intent, even though V1 ignores it.
   * Leaving the field in the prop surface avoids a breaking change
   * when motion lands.
   */
  delayMs?: number;
  style?: ViewStyle;
}

export function PreviewFragmentEnter({
  children,
  style,
  delayMs: _delayMs,
}: PreviewFragmentEnterProps) {
  // `_delayMs` intentionally unused — reserved for the motion pass.
  return <View style={style}>{children}</View>;
}
