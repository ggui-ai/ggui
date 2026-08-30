/**
 * UiFeedback — a small, dismissable rating affordance for the render
 * shell chrome ("did this generated UI work for you?").
 *
 * Two verdicts — thumbs up / thumbs down (#653) — plus a dismiss
 * control. Entirely host-driven: the component renders NOTHING unless
 * the host passes `onUiFeedback`, so deployments that don't collect
 * feedback never show a dead affordance. Where the payload goes is the
 * host's choice — a logger, an analytics client, a support inbox; this
 * component only builds the typed {@link UiFeedbackPayload} and hands
 * it over.
 *
 * The verdict buttons are icon-only: monochrome stroked SVGs drawn in
 * `currentColor`, so the icon ink follows the button's `--ggui-*`
 * color token in both modes (the #653 theme-applicability
 * requirement). The verdict's name lives in the `aria-label`.
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
import { useCallback, useState, type CSSProperties } from 'react';

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
  display: 'inline-flex',
  alignItems: 'center',
  background: 'var(--ggui-color-neutral-50, #f9fafb)',
  border: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
  borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
  padding: '3px 7px',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  // The icons stroke in currentColor — this token IS the icon ink.
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

/**
 * Monochrome stroked thumb icons. `stroke="currentColor"` is the
 * theme-applicability contract: the glyph takes whatever ink the
 * button's `color` token resolves to, in either mode.
 */
function ThumbIcon({ direction }: { direction: UiFeedbackVerdict }) {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {direction === 'up' ? (
        <>
          <path d="M7 10v12" />
          <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
        </>
      ) : (
        <>
          <path d="M17 14V2" />
          <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
        </>
      )}
    </svg>
  );
}

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
    <div
      data-ggui-ui-feedback
      role="group"
      aria-label="Share feedback on this UI"
      style={rootStyle}
    >
      {phase === 'sent' ? (
        <span data-ggui-ui-feedback-thanks>Thanks for the feedback</span>
      ) : (
        (['up', 'down'] as const).map((verdict) => (
          <button
            key={verdict}
            type="button"
            style={verdictButtonStyle}
            data-ggui-ui-feedback-verdict={verdict}
            aria-label={VERDICT_LABELS[verdict]}
            title={VERDICT_LABELS[verdict]}
            onClick={() => emit(verdict)}
          >
            <ThumbIcon direction={verdict} />
          </button>
        ))
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
