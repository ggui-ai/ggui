/**
 * UiFeedbackCard — the runtime's in-iframe UI-feedback affordance
 * ("did this generated UI work for you?").
 *
 * The in-iframe twin of the host-chrome `UiFeedback` component in
 * `@ggui-ai/mcp-apps-react`: same two verdicts — thumbs up / thumbs
 * down (#653) — same acknowledgement after submit, same dismiss
 * control, same payload semantics (context stamps present exactly when
 * known). Where the host-chrome twin hands a payload to an
 * `onUiFeedback` callback, this card builds a {@link UiFeedbackEvent}
 * and hands it to the injected {@link ObservabilityEmitter} —
 * production binds the `ggui:observe` postMessage-to-parent default,
 * tests record.
 *
 * The verdict buttons are icon-only: monochrome stroked SVGs drawn in
 * `currentColor`, so the icon ink follows the button's `--ggui-*`
 * color token in both modes (the #653 theme-applicability
 * requirement). The verdict's name lives in the `aria-label`.
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

type Phase = 'idle' | 'sent' | 'dismissed';

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
      display: 'inline-flex',
      alignItems: 'center',
      background: dark
        ? 'var(--ggui-color-neutral-50, #1f2937)'
        : 'var(--ggui-color-neutral-50, #f9fafb)',
      border: dark
        ? '1px solid var(--ggui-color-neutral-200, #374151)'
        : '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
      borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
      padding: '3px 7px',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      // The icons stroke in currentColor — this token IS the icon ink.
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
  };
}

/**
 * Monochrome stroked thumb icons. `stroke="currentColor"` is the
 * theme-applicability contract: the glyph takes whatever ink the
 * button's `color` token resolves to, in either mode.
 */
function ThumbIcon({
  direction,
}: {
  readonly direction: UiFeedbackEvent['verdict'];
}): React.JSX.Element {
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

const VERDICT_LABELS: Record<UiFeedbackEvent['verdict'], string> = {
  up: 'Thumbs up',
  down: 'Thumbs down',
};

export function UiFeedbackCard({
  emit,
  sessionId,
  toolName,
}: UiFeedbackCardProps): React.JSX.Element | null {
  const [phase, setPhase] = React.useState<Phase>('idle');
  const scheme = useColorScheme();
  const styles = buildStyles(scheme);

  const send = React.useCallback(
    (verdict: UiFeedbackEvent['verdict']) => {
      emit({
        kind: 'ui-feedback',
        verdict,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
      });
      setPhase('sent');
    },
    [emit, sessionId, toolName],
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
      ) : (
        (['up', 'down'] as const).map((verdict) => (
          <button
            key={verdict}
            type="button"
            style={styles.verdictButton}
            data-ggui-ui-feedback-verdict={verdict}
            aria-label={VERDICT_LABELS[verdict]}
            title={VERDICT_LABELS[verdict]}
            onClick={() => send(verdict)}
          >
            <ThumbIcon direction={verdict} />
          </button>
        ))
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
