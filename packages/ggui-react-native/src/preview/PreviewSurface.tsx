/**
 * PreviewSurface — RN-native wrapper for provisional UI assembly.
 *
 * Parity with `@ggui-ai/design/preview/PreviewSurface` where it matters:
 *
 *   - frosted tint establishes a distinct visual region
 *   - `pointer-events: none` / `disabled` on descendants so control
 *     shells never respond during assembly
 *   - `accessibilityState={{busy: true}}` so assistive tech reads the
 *     surface as in-progress
 *
 * Where RN honestly diverges from web V1:
 *
 *   - No shimmer sweep. The web version uses CSS `@keyframes` +
 *     `mix-blend-mode`; the RN equivalent would require `Animated.loop`
 *     plus `Animated.View` plus `interpolate()` plumbing that isn't
 *     stubbed in our test environment and offers brittle ROI at V1
 *     scope. Instead, a small `ActivityIndicator` + the tint is the
 *     "alive" signal — a polished RN shimmer can land as a later
 *     dedicated slice once motion infrastructure is exercised more
 *     broadly.
 *
 * Non-goals in this primitive:
 *   - State.
 *   - Reading A2UI payloads.
 *   - Knowing what `_ggui:preview` is.
 *
 * Keeps the boundary — visual identity only.
 */
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';

export interface PreviewSurfaceProps {
  children?: ReactNode;
  /**
   * When `true`, hides the activity indicator. Consumers set this
   * once the authoritative render is about to take over — a static
   * tint reads as "ready to hand off" rather than "still thinking".
   */
  frozen?: boolean;
  style?: ViewStyle;
}

export function PreviewSurface({
  children,
  frozen = false,
  style,
}: PreviewSurfaceProps) {
  return (
    <View
      accessibilityState={{ busy: true }}
      accessibilityRole="progressbar"
      style={[styles.surface, style]}
      // Every descendant's touch/press is swallowed. This is the
      // second layer of non-interactivity — disabled props on the
      // control shells are the first.
      pointerEvents="box-only"
    >
      <View style={styles.content} pointerEvents="none">
        {children}
      </View>
      {frozen ? null : (
        <View style={styles.indicator} pointerEvents="none">
          <ActivityIndicator size="small" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    position: 'relative',
    backgroundColor: 'rgba(148, 163, 184, 0.08)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  content: {
    position: 'relative',
  },
  indicator: {
    position: 'absolute',
    right: 8,
    top: 8,
  },
});
