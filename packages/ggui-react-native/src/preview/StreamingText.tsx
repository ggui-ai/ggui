/**
 * StreamingText — RN analog of the web primitive, with a static caret
 * glyph instead of a blinking one.
 *
 * Rationale for static-only:
 *
 *   - The web version uses `@keyframes ggui-preview-caret` — a CSS
 *     1-frame opacity pulse. The RN parity would pull in `Animated.loop`
 *     and `Animated.sequence`, neither of which is stubbed in the
 *     test-setup's Animated mock. Shipping a working static caret
 *     carries the signal (text-is-mid-stream) without requiring an
 *     infrastructure detour.
 *   - The caret can still animate in a later motion-focused slice
 *     without touching the renderer's call site — expand this file,
 *     leave the renderer unchanged.
 *
 * The component itself does NOT apply typography. Callers render
 * `<Text>` or a heading equivalent as children and this wrapper only
 * decorates the tail; the RN renderer already picks the right type
 * styles from `theme/tokens`.
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

export interface StreamingTextProps {
  children: ReactNode;
  /** When `true`, a caret glyph is rendered at the tail of the text. */
  streaming?: boolean;
}

export function StreamingText({
  children,
  streaming = false,
}: StreamingTextProps) {
  // Wrapping in a row-flex View keeps the caret inline with the
  // trailing character — simpler than relying on inline `Text`
  // concatenation which renders inconsistently across RN versions.
  return (
    <View style={styles.wrapper}>
      <View style={styles.content}>{children}</View>
      {streaming ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={styles.caret}
        >
          {'▌'}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  content: {
    flexShrink: 1,
  },
  caret: {
    marginLeft: 2,
    // Quietly de-emphasised so the caret reads as a tail marker, not
    // a character in the copy.
    opacity: 0.6,
  },
});
