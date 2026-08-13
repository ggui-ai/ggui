/**
 * UiFeedbackCard — the runtime's in-iframe UI-feedback affordance
 * ("did this generated UI work for you?").
 *
 * The in-iframe twin of the host-chrome `UiFeedback` component in
 * `@ggui-ai/mcp-apps-react`: same three verdicts — Love / Dislike / Other
 * (free-text comment) — same acknowledgement after submit, same
 * dismiss control, same payload semantics (trimmed comment only on
 * `verdict: 'other'`, context stamps present exactly when known).
 * Where the host-chrome twin hands a payload to an `onUiFeedback`
 * callback, this card builds a {@link UiFeedbackEvent} and hands it to
 * the injected {@link ObservabilityEmitter} — production binds the
 * `ggui:observe` postMessage-to-parent default, tests record.
 *
 * This is CHROME the runtime mounts adjacent to the session root
 * (see `ui-feedback-chrome.ts`), NOT a system card: it has no
 * `SystemGguiSession.kind`, no registry entry, and no server-side
 * producer. It lives in this directory because it follows the
 * system-card authoring idiom — inline styles with `--ggui-*`
 * CSS-variable hooks and {@link useColorScheme} adaptation — and
 * because the dynamic-import posture keeps it out of the runtime's
 * base module graph.
 *
 * No ThemeProvider on purpose: the adjacent user render owns the
 * document's `--ggui-*` variable layer (its own theme injection wrote
 * `:root`), and wrapping this card in a ThemeProvider would overwrite
 * those variables last-writer-wins. Inline `var(--ggui-*, fallback)`
 * styles pick up the render's theme when present; the
 * scheme-conditional fallbacks keep the card readable when no theme
 * variables were injected at all.
 */
import * as React from 'react';
import type { ObservabilityEmitter, UiFeedbackEvent } from '../observability.js';
import { useColorScheme } from './host-detect.js';

export interface UiFeedbackCardProps {
  /**
   * Sink for the built {@link UiFeedbackEvent}. Required — the mount
   * gate (`ui-feedback-chrome.ts`) guarantees a reachable parent
   * before this card ever renders, so there is no unsunk state.
   */
  readonly emit: ObservabilityEmitter;
  /** GguiSession id stamped onto every emitted event, when known. */
  readonly sessionId?: string;
  /** Producing tool name stamped onto every emitted event, when known. */
  readonly toolName?: string;
}

type Phase = 'idle' | 'comment' | 'sent' | 'dismissed';

const FONT_FAMILY =
  "var(--ggui-font-family-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)";

/**
 * Scheme-conditional style palette. The `var(--ggui-*, …)` fallbacks
 * flip between the neutral light values (mirroring the host-chrome
 * twin) and dark-readable equivalents so the card stays legible on
 * hosts that render the iframe over a dark surface without injecting
 * theme variables.
 */
function buildStyles(scheme: 'light' | 'dark'): {
  root: React.CSSProperties;
  verdictButton: React.CSSProperties;
  dismissButton: React.CSSProperties;
  commentForm: React.CSSProperties;
  commentInput: React.CSSProperties;
} {
  const dark = scheme === 'dark';
  return {
    root: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontFamily: FONT_FAMILY,
      fontSize: 12,
      lineHeight: 1.2,
      color: dark
        ? 'var(--ggui-color-neutral-500, #9ca3af)'
        : 'var(--ggui-color-neutral-500, #6b7280)',
    },
    verdictButton: {
      appearance: 'none',
      background: dark
        ? 'var(--ggui-color-neutral-50, #1f2937)'
        : 'var(--ggui-color-neutral-50, #f9fafb)',
      border: dark
        ? '1px solid var(--ggui-color-neutral-200, #374151)'
        : '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
      borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
      padding: '2px 8px',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      color: dark
        ? 'var(--ggui-color-neutral-600, #d1d5db)'
        : 'var(--ggui-color-neutral-600, #4b5563)',
      cursor: 'pointer',
    },
    dismissButton: {
      appearance: 'none',
      background: 'transparent',
      border: 'none',
      padding: '2px 4px',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      color: dark
        ? 'var(--ggui-color-neutral-400, #6b7280)'
        : 'var(--ggui-color-neutral-400, #9ca3af)',
      cursor: 'pointer',
    },
    commentForm: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      margin: 0,
    },
    commentInput: {
      fontFamily: 'inherit',
      fontSize: 'inherit',
      padding: '2px 6px',
      minWidth: 140,
      border: dark
        ? '1px solid var(--ggui-color-neutral-200, #374151)'
        : '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
      borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
      background: dark
        ? 'var(--ggui-color-neutral-50, #111827)'
        : 'var(--ggui-color-neutral-50, #ffffff)',
      color: dark
        ? 'var(--ggui-color-neutral-800, #e5e7eb)'
        : 'var(--ggui-color-neutral-800, #1f2937)',
    },
  };
}

export function UiFeedbackCard({
  emit,
  sessionId,
  toolName,
}: UiFeedbackCardProps): React.JSX.Element | null {
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [comment, setComment] = React.useState('');
  const scheme = useColorScheme();
  const styles = buildStyles(scheme);

  const send = React.useCallback(
    (verdict: UiFeedbackEvent['verdict'], commentText?: string) => {
      const trimmed = commentText?.trim();
      emit({
        kind: 'ui-feedback',
        verdict,
        ...(trimmed !== undefined && trimmed.length > 0 ? { comment: trimmed } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
      });
      setPhase('sent');
    },
    [emit, sessionId, toolName],
  );

  const onCommentSubmit = React.useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      send('other', comment);
    },
    [send, comment],
  );

  if (phase === 'dismissed') return null;

  return (
    <div
      data-ggui-ui-feedback
      role="group"
      aria-label="Share feedback on this UI"
      style={styles.root}
    >
      {phase === 'sent' ? (
        <span data-ggui-ui-feedback-thanks>Thanks for the feedback</span>
      ) : phase === 'comment' ? (
        <form
          onSubmit={onCommentSubmit}
          style={styles.commentForm}
          data-ggui-ui-feedback-comment-form
        >
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What happened?"
            aria-label="Feedback comment"
            data-ggui-ui-feedback-comment
            style={styles.commentInput}
            autoFocus
          />
          <button type="submit" style={styles.verdictButton} data-ggui-ui-feedback-send>
            Send
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            style={styles.verdictButton}
            data-ggui-ui-feedback-verdict="love"
            onClick={() => send('love')}
          >
            Love
          </button>
          <button
            type="button"
            style={styles.verdictButton}
            data-ggui-ui-feedback-verdict="dislike"
            onClick={() => send('dislike')}
          >
            Dislike
          </button>
          <button
            type="button"
            style={styles.verdictButton}
            data-ggui-ui-feedback-verdict="other"
            onClick={() => setPhase('comment')}
          >
            Other…
          </button>
        </>
      )}
      <button
        type="button"
        style={styles.dismissButton}
        aria-label="Dismiss feedback"
        data-ggui-ui-feedback-dismiss
        onClick={() => setPhase('dismissed')}
      >
        {'×'}
      </button>
    </div>
  );
}
