/**
 * UiFeedback — a small, dismissable rating affordance for the render
 * shell chrome ("did this generated UI work for you?").
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
 *
 * Styling follows the package idiom: inline styles with `--ggui-*`
 * CSS-variable hooks + neutral fallbacks (same pattern as
 * AgentBrowsePanel), so host themes restyle it via the variable layer.
 * The root carries `data-ggui-ui-feedback` as the styling/layout hook
 * for host CSS.
 */
import { useCallback, useState, type CSSProperties, type FormEvent } from 'react';

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

const FONT_FAMILY =
  "var(--ggui-font-family-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)";

const rootStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontFamily: FONT_FAMILY,
  fontSize: 12,
  lineHeight: 1.2,
  color: 'var(--ggui-color-neutral-500, #6b7280)',
};

const verdictButtonStyle: CSSProperties = {
  appearance: 'none',
  background: 'var(--ggui-color-neutral-50, #f9fafb)',
  border: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
  borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
  padding: '2px 8px',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  color: 'var(--ggui-color-neutral-600, #4b5563)',
  cursor: 'pointer',
};

const dismissButtonStyle: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  padding: '2px 4px',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  color: 'var(--ggui-color-neutral-400, #9ca3af)',
  cursor: 'pointer',
};

const commentFormStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  margin: 0,
};

const commentInputStyle: CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 'inherit',
  padding: '2px 6px',
  minWidth: 140,
  border: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
  borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
  background: 'var(--ggui-color-neutral-50, #ffffff)',
  color: 'var(--ggui-color-neutral-800, #1f2937)',
};

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

  const onCommentSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      emit('other', comment);
    },
    [emit, comment],
  );

  // Hidden entirely: no sink wired, or the user dismissed it.
  if (!onUiFeedback || phase === 'dismissed') return null;

  return (
    <div
      data-ggui-ui-feedback
      role="group"
      aria-label="Share feedback on this UI"
      style={rootStyle}
    >
      {phase === 'sent' ? (
        <span data-ggui-ui-feedback-thanks>Thanks for the feedback</span>
      ) : phase === 'comment' ? (
        <form onSubmit={onCommentSubmit} style={commentFormStyle} data-ggui-ui-feedback-comment-form>
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What happened?"
            aria-label="Feedback comment"
            data-ggui-ui-feedback-comment
            style={commentInputStyle}
            autoFocus
          />
          <button type="submit" style={verdictButtonStyle} data-ggui-ui-feedback-send>
            Send
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            style={verdictButtonStyle}
            data-ggui-ui-feedback-verdict="love"
            onClick={() => emit('love')}
          >
            Love
          </button>
          <button
            type="button"
            style={verdictButtonStyle}
            data-ggui-ui-feedback-verdict="dislike"
            onClick={() => emit('dislike')}
          >
            Dislike
          </button>
          <button
            type="button"
            style={verdictButtonStyle}
            data-ggui-ui-feedback-verdict="other"
            onClick={() => setPhase('comment')}
          >
            Other…
          </button>
        </>
      )}
      <button
        type="button"
        style={dismissButtonStyle}
        aria-label="Dismiss feedback"
        data-ggui-ui-feedback-dismiss
        onClick={() => setPhase('dismissed')}
      >
        {'×'}
      </button>
    </div>
  );
}
