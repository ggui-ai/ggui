/**
 * UiFeedback — a small, dismissable rating affordance for the render
 * shell chrome ("did this generated UI work for you?").
 *
 * Platform delta (vs `ggui-react/src/components/UiFeedback.tsx`):
 *   - DOM elements (`div` / `button`) become RN primitives
 *     (`View` / `Pressable` / `Text`).
 *   - Inline styles with `--ggui-*` CSS-variable hooks become
 *     `StyleSheet.create` constants carrying the same neutral palette
 *     the web copy uses as its variable fallbacks (RN has no CSS
 *     variable layer).
 *   - `data-ggui-ui-feedback*` styling/test hooks become `testID`s
 *     (`ggui-ui-feedback`, `ggui-ui-feedback-verdict-<verdict>`, …).
 *   - `role` / `aria-label` become `accessibilityLabel` /
 *     `accessibilityRole` props.
 *   - The web copy's monochrome stroked SVG thumbs become 👍 / 👎
 *     emoji glyphs in `Text` (#653 lean call: `react-native-svg` is
 *     not a dependency of this package and one chrome row does not
 *     justify adding it to the lockstep wave; the glyph renders in the
 *     platform's emoji face rather than the theme ink — revisit if a
 *     ggui icon dependency ever lands for other reasons).
 * The exported surface is identical to the web copy — pinned by the
 * twin-parity gate (`DOCUMENTED_DELTA_TWINS`).
 *
 * Two verdicts — thumbs up / thumbs down (#653) — plus a dismiss
 * control. Entirely host-driven: the component renders NOTHING unless
 * the host passes `onUiFeedback`, so deployments that don't collect
 * feedback never show a dead affordance. Where the payload goes is
 * the host's choice — a logger, an analytics client, a support inbox;
 * this component only builds the typed {@link UiFeedbackPayload} and
 * hands it over.
 *
 * Zero wire surface: feedback never crosses the agent ↔ UI contract.
 * It is host-app chrome (Data vs Behavior — the agent cannot observe
 * it from the wire, so it is not protocol data), which is why the
 * payload leaves through a host callback rather than a contract spec.
 *
 * Two mount surfaces exist for this affordance (ggui#244):
 *
 *   1. THIS component — chrome in the host's own tree, next to a
 *      render surface the host controls; the payload leaves through
 *      `onUiFeedback`.
 *   2. The in-iframe twin the `@ggui-ai/iframe-runtime` boot path
 *      mounts inside a served render iframe whenever a parent window
 *      exists (`window.parent !== window` — top-level tabs get
 *      neither surface); its payload leaves as a `ui-feedback`
 *      observability event on the `ggui:observe` postMessage seam,
 *      surfaced to hosts via `<McpAppIframe onObserve>`.
 *
 * Hosts wire exactly ONE surface — either pass `onUiFeedback` here
 * and ignore the `ui-feedback` observe arm, or handle the observe arm
 * and omit `onUiFeedback`. Wiring both shows the user two affordances
 * for one render. The render-nothing-without-a-sink default makes the
 * choice safe: omitting `onUiFeedback` fully disables this surface.
 */
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** The two feedback verdicts the affordance can emit. */
export type UiFeedbackVerdict = 'up' | 'down';

/**
 * Payload handed to {@link UiFeedbackProps.onUiFeedback}. Context
 * fields are present exactly when the host supplied them as props.
 */
export interface UiFeedbackPayload {
  verdict: UiFeedbackVerdict;
  /** GguiSession id of the render the feedback is about. */
  sessionId?: string;
  /** Tool that produced the render (e.g. `ggui_render`). */
  toolName?: string;
}

export interface UiFeedbackProps {
  /**
   * Feedback sink. Absent = the affordance renders nothing at all —
   * zero-config hosts never show a dead control.
   */
  onUiFeedback?: (feedback: UiFeedbackPayload) => void;
  /** GguiSession id to stamp onto every emitted payload. */
  sessionId?: string;
  /** Producing tool name to stamp onto every emitted payload. */
  toolName?: string;
}

type Phase = 'idle' | 'sent' | 'dismissed';

const VERDICT_GLYPHS: Record<UiFeedbackVerdict, string> = {
  up: '👍',
  down: '👎',
};

const VERDICT_LABELS: Record<UiFeedbackVerdict, string> = {
  up: 'Thumbs up',
  down: 'Thumbs down',
};

export function UiFeedback({ onUiFeedback, sessionId, toolName }: UiFeedbackProps) {
  const [phase, setPhase] = useState<Phase>('idle');

  const emit = useCallback(
    (verdict: UiFeedbackVerdict) => {
      if (!onUiFeedback) return;
      onUiFeedback({
        verdict,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
      });
      setPhase('sent');
    },
    [onUiFeedback, sessionId, toolName],
  );

  // Hidden entirely: no sink wired, or the user dismissed it.
  if (!onUiFeedback || phase === 'dismissed') return null;

  return (
    <View
      testID="ggui-ui-feedback"
      accessibilityLabel="Share feedback on this UI"
      style={styles.root}
    >
      {phase === 'sent' ? (
        <Text testID="ggui-ui-feedback-thanks" style={styles.thanksText}>
          Thanks for the feedback
        </Text>
      ) : (
        (['up', 'down'] as const).map((verdict) => (
          <Pressable
            key={verdict}
            accessibilityRole="button"
            accessibilityLabel={VERDICT_LABELS[verdict]}
            style={styles.verdictButton}
            testID={`ggui-ui-feedback-verdict-${verdict}`}
            onPress={() => emit(verdict)}
          >
            <Text style={styles.verdictText}>{VERDICT_GLYPHS[verdict]}</Text>
          </Pressable>
        ))
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss feedback"
        style={styles.dismissButton}
        testID="ggui-ui-feedback-dismiss"
        onPress={() => setPhase('dismissed')}
      >
        <Text style={styles.dismissText}>{'×'}</Text>
      </Pressable>
    </View>
  );
}

// Neutral palette mirrors the web copy's CSS-variable fallbacks.
const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
  },
  thanksText: {
    fontSize: 12,
    color: '#6b7280',
  },
  verdictButton: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 4,
    paddingVertical: 3,
    paddingHorizontal: 7,
  },
  verdictText: {
    fontSize: 12,
    lineHeight: 14,
  },
  dismissButton: {
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  dismissText: {
    fontSize: 12,
    color: '#9ca3af',
  },
});
