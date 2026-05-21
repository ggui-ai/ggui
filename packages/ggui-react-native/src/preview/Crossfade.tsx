/**
 * Crossfade — provisional→final handoff on React Native.
 *
 * V1 semantics: swap, no fade. When `to` is `null`, render `from`;
 * otherwise render `to`. The web version runs a paired opacity
 * transition; the RN parity would require an `Animated.View` chain
 * that isn't on the critical path for this slice.
 *
 * The prop shape is deliberately compatible with the web signature
 * so a future motion-enabled RN version doesn't churn callers.
 */
import type { ReactNode } from 'react';
import type { ViewStyle } from 'react-native';
import { View } from 'react-native';

export interface CrossfadeProps {
  /** Provisional render shown until `to` arrives. */
  from: ReactNode;
  /** Final render — `null` while unavailable, then takes over. */
  to: ReactNode | null;
  /**
   * Fade duration. Honored only in a future animated variant; the
   * V1 swap ignores it. Left on the signature so consumers don't
   * have to rewrite when motion lands.
   */
  durationMs?: number;
  style?: ViewStyle;
}

export function Crossfade({ from, to, style, durationMs: _durationMs }: CrossfadeProps) {
  // `_durationMs` intentionally unused — see file-level JSDoc.
  return <View style={style}>{to === null ? from : to}</View>;
}
