/**
 * UiFeedback — a small, dismissable rating affordance for the render
 * shell chrome ("did this generated UI work for you?").
 *
 * Platform delta (vs `ggui-react/src/components/UiFeedback.tsx`):
 *   - DOM elements (`div` / `button` / `form` / `input`) become RN
 *     primitives (`View` / `Pressable` / `Text` / `TextInput`).
 *   - Inline styles with `--ggui-*` CSS-variable hooks become
 *     `StyleSheet.create` constants carrying the same neutral palette
 *     the web copy uses as its variable fallbacks (RN has no CSS
 *     variable layer).
 *   - `data-ggui-ui-feedback*` styling/test hooks become `testID`s
 *     (`ggui-ui-feedback`, `ggui-ui-feedback-verdict-<verdict>`, …).
 *   - The comment `<form>` submit becomes a Send `Pressable` plus the
 *     `TextInput`'s `onSubmitEditing` (keyboard return key).
 *   - `role` / `aria-label` become `accessibilityLabel` /
 *     `accessibilityRole` props.
 * The exported surface is identical to the web copy — pinned by the
 * twin-parity gate (`DOCUMENTED_DELTA_TWINS`).
 *
 * Three verdicts — Love / Dislike / Other (free-text comment) — plus a
 * dismiss control. Entirely host-driven: the component renders NOTHING
 * unless the host passes `onUiFeedback`, so deployments that don't
 * collect feedback never show a dead affordance. Where the payload
 * goes is the host's choice — a logger, an analytics client, a support
 * inbox; this component only builds the typed {@link UiFeedbackPayload}
 * and hands it over.
 *
 * Zero wire surface: feedback never crosses the agent ↔ UI contract.
 * It is host-app chrome (Data vs Behavior — the agent cannot observe
 * it from the wire, so it is not protocol data), which is why the
 * payload leaves through a host callback rather than a contract spec.
 */
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

/** The three feedback verdicts the affordance can emit. */
export type UiFeedbackVerdict = 'love' | 'dislike' | 'other';

/**
 * Payload handed to {@link UiFeedbackProps.onUiFeedback}. Context
 * fields are present exactly when the host supplied them as props;
 * `comment` is present only for `verdict: 'other'` with a non-empty
 * trimmed comment.
 */
export interface UiFeedbackPayload {
  verdict: UiFeedbackVerdict;
  comment?: string;
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

type Phase = 'idle' | 'comment' | 'sent' | 'dismissed';

export function UiFeedback({ onUiFeedback, sessionId, toolName }: UiFeedbackProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [comment, setComment] = useState('');

  const emit = useCallback(
    (verdict: UiFeedbackVerdict, commentText?: string) => {
      if (!onUiFeedback) return;
      const trimmed = commentText?.trim();
      onUiFeedback({
        verdict,
        ...(trimmed !== undefined && trimmed.length > 0 ? { comment: trimmed } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
      });
      setPhase('sent');
    },
    [onUiFeedback, sessionId, toolName],
  );

  const onCommentSubmit = useCallback(() => {
    emit('other', comment);
  }, [emit, comment]);

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
      ) : phase === 'comment' ? (
        <View style={styles.commentForm} testID="ggui-ui-feedback-comment-form">
          <TextInput
            value={comment}
            onChangeText={setComment}
            onSubmitEditing={onCommentSubmit}
            placeholder="What happened?"
            accessibilityLabel="Feedback comment"
            testID="ggui-ui-feedback-comment"
            style={styles.commentInput}
            autoFocus
          />
          <Pressable
            accessibilityRole="button"
            style={styles.verdictButton}
            testID="ggui-ui-feedback-send"
            onPress={onCommentSubmit}
          >
            <Text style={styles.verdictText}>Send</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            style={styles.verdictButton}
            testID="ggui-ui-feedback-verdict-love"
            onPress={() => emit('love')}
          >
            <Text style={styles.verdictText}>Love</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.verdictButton}
            testID="ggui-ui-feedback-verdict-dislike"
            onPress={() => emit('dislike')}
          >
            <Text style={styles.verdictText}>Dislike</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.verdictButton}
            testID="ggui-ui-feedback-verdict-other"
            onPress={() => setPhase('comment')}
          >
            <Text style={styles.verdictText}>Other…</Text>
          </Pressable>
        </>
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
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  verdictText: {
    fontSize: 12,
    color: '#4b5563',
  },
  dismissButton: {
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  dismissText: {
    fontSize: 12,
    color: '#9ca3af',
  },
  commentForm: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  commentInput: {
    fontSize: 12,
    paddingVertical: 2,
    paddingHorizontal: 6,
    minWidth: 140,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 4,
    backgroundColor: '#ffffff',
    color: '#1f2937',
  },
});
