/**
 * Animator pill.
 *
 * Visual component that renders the current `AnimatorState`. Two
 * layouts:
 *
 *   - centered (when canvas navStack is empty): pill at ~40% top
 *   - navbar (when canvas has content): pill compressed into top chrome
 *
 * V1 ships PLACEHOLDER visuals per the design doc. Behavioral spec is
 * locked; the designer pass refines exact motion + sizing. Engineering
 * baseline: pill shape, brand accent dot, label text, pulse animation
 * via CSS keyframes.
 *
 * Boundary discipline:
 *   - Pure view component. Takes `state` + `layout` props, renders DOM.
 *   - No state, no effects, no subscriptions. Parent (animator-host)
 *     owns those.
 *   - Accessibility: `aria-live="polite"` for routine transitions;
 *     `assertive` for error. Reduced-motion honored via CSS.
 */

import { type CSSProperties, type ReactNode } from 'react';
import type { AnimatorState } from './state-machine.js';

export interface AnimatorPillProps {
  readonly state: AnimatorState;
  /**
   * Where to draw the pill. The shell decides based on navStack
   * emptiness:
   *   - `'centered'` — canvas empty; pill fills (vertically offset
   *     above center).
   *   - `'navbar'` — canvas has content; pill compressed into the
   *     top chrome.
   */
  readonly layout: 'centered' | 'navbar';
  /**
   * Brand label shown when state is `ready` (otherwise the active
   * label is derived from state). Falls back to `'ggui'` per
   * decisions.md.
   */
  readonly readyLabel?: string;
}

/**
 * Derive the user-facing label from the state. Centralized so the
 * announcement text + visible text stay in lockstep.
 */
function labelForState(state: AnimatorState, readyLabel: string): string {
  switch (state.kind) {
    case 'ready':
      return readyLabel;
    case 'handshake':
      return `Negotiating: ${state.intent}`;
    case 'constructing':
      return `Building: ${state.intent}`;
    case 'listening':
      return 'Listening…';
    case 'content':
      switch (state.substate.kind) {
        case 'idle':
          return state.activeItemId;
        case 'handshake':
          return `Negotiating: ${state.substate.intent}`;
        case 'constructing':
          return `Building: ${state.substate.intent}`;
        case 'listening':
          return 'Listening…';
      }
    // eslint-disable-next-line no-fallthrough
    case 'error':
      return `Error: ${state.message}`;
    case 'offline':
      return 'Offline — reconnecting…';
  }
}

/**
 * The dot animation depends on outer state OR the active substate
 * when on `content`.
 */
function indicatorClassFor(state: AnimatorState): string {
  switch (state.kind) {
    case 'ready':
      return 'ggui-animator-dot--ready';
    case 'handshake':
      return 'ggui-animator-dot--handshake';
    case 'constructing':
      return 'ggui-animator-dot--constructing';
    case 'listening':
      return 'ggui-animator-dot--listening';
    case 'content':
      switch (state.substate.kind) {
        case 'idle':
          return 'ggui-animator-dot--content-idle';
        case 'handshake':
          return 'ggui-animator-dot--handshake';
        case 'constructing':
          return 'ggui-animator-dot--constructing';
        case 'listening':
          return 'ggui-animator-dot--listening';
      }
    // eslint-disable-next-line no-fallthrough
    case 'error':
      return 'ggui-animator-dot--error';
    case 'offline':
      return 'ggui-animator-dot--offline';
  }
}

/**
 * Inline styles for the placeholder visual. Replaced by the designer
 * pass with a real CSS module. Keeping them inline avoids the
 * CSS-loader plumbing question for v1.
 */
const pillStyles = {
  centered: {
    position: 'absolute',
    top: '40%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    borderRadius: 9999,
    background: 'var(--ggui-color-surface, rgba(245, 245, 245, 0.95))',
    border: '1px solid var(--ggui-color-outlineVariant, rgba(148, 163, 184, 0.3))',
    fontSize: 13,
    color: 'var(--ggui-color-onSurface, #1a1a1a)',
    fontFamily: 'inherit',
  } satisfies CSSProperties,
  navbar: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 12px',
    borderRadius: 9999,
    background: 'var(--ggui-color-surface, rgba(245, 245, 245, 0.95))',
    border: '1px solid var(--ggui-color-outlineVariant, rgba(148, 163, 184, 0.3))',
    fontSize: 12,
    color: 'var(--ggui-color-onSurface, #1a1a1a)',
    fontFamily: 'inherit',
  } satisfies CSSProperties,
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--ggui-color-primary, #2563eb)',
    flexShrink: 0,
  } satisfies CSSProperties,
  errorDot: {
    background: 'var(--ggui-color-error, #b91c1c)',
  } satisfies CSSProperties,
};

export function AnimatorPill({
  state,
  layout,
  readyLabel = 'ggui',
}: AnimatorPillProps): ReactNode {
  const label = labelForState(state, readyLabel);
  const dotClass = indicatorClassFor(state);

  const dotStyle: CSSProperties = {
    ...pillStyles.dot,
    ...(state.kind === 'error' ? pillStyles.errorDot : {}),
  };

  return (
    <div
      role="status"
      aria-live={state.kind === 'error' ? 'assertive' : 'polite'}
      aria-label={label}
      style={layout === 'centered' ? pillStyles.centered : pillStyles.navbar}
      data-ggui-animator-state={state.kind}
      data-ggui-animator-layout={layout}
    >
      <span className={dotClass} style={dotStyle} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
