/**
 * UiFeedback — behaviour tests for the render-shell feedback
 * affordance: hidden-without-callback gating, the two thumb verdicts
 * (context stamping + omission of absent fields), icon-only a11y
 * labelling, theme-ink icon rendering, the post-submit
 * acknowledgement, and dismissal.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { UiFeedback } from './UiFeedback';
import type { UiFeedbackPayload } from './UiFeedback';

function feedbackSink() {
  return vi.fn<(feedback: UiFeedbackPayload) => void>();
}

/** Strict querySelector — throws instead of returning null. */
function q(container: HTMLElement, selector: string): Element {
  const el = container.querySelector(selector);
  if (el === null) throw new Error(`expected element matching ${selector}`);
  return el;
}

describe('UiFeedback', () => {
  it('renders nothing when no onUiFeedback callback is wired', () => {
    const { container } = render(
      <UiFeedback sessionId="sess-1" toolName="ggui_render" />,
    );
    expect(container.querySelector('[data-ggui-ui-feedback]')).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('emits an up verdict stamped with session context', () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(
      <UiFeedback
        onUiFeedback={onUiFeedback}
        sessionId="sess-1"
        toolName="ggui_render"
      />,
    );
    fireEvent.click(q(container, '[data-ggui-ui-feedback-verdict="up"]'));
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({
      verdict: 'up',
      sessionId: 'sess-1',
      toolName: 'ggui_render',
    });
  });

  it('renders exactly two icon-only verdict buttons with accessible names', () => {
    const { container } = render(<UiFeedback onUiFeedback={feedbackSink()} />);
    const up = q(container, '[data-ggui-ui-feedback-verdict="up"]');
    const down = q(container, '[data-ggui-ui-feedback-verdict="down"]');
    // #653: the words left the row — the name lives in the aria-label.
    expect(up.getAttribute('aria-label')).toBe('Thumbs up');
    expect(down.getAttribute('aria-label')).toBe('Thumbs down');
    expect(up.textContent).toBe('');
    expect(down.textContent).toBe('');
    // No third verdict, no free-text affordance (founder-scoped to two).
    expect(
      container.querySelectorAll('[data-ggui-ui-feedback-verdict]'),
    ).toHaveLength(2);
    expect(container.querySelector('[data-ggui-ui-feedback-comment]')).toBeNull();
  });

  it('draws the icons in theme ink (stroke=currentColor SVGs)', () => {
    const { container } = render(<UiFeedback onUiFeedback={feedbackSink()} />);
    for (const v of ['up', 'down'] as const) {
      const svg = q(container, `[data-ggui-ui-feedback-verdict="${v}"] svg`);
      // currentColor is the theme-applicability contract (#653): the
      // icon ink follows the button's --ggui-* color token in both modes.
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.getAttribute('fill')).toBe('none');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('omits context fields the host did not supply', () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(<UiFeedback onUiFeedback={onUiFeedback} />);
    fireEvent.click(q(container, '[data-ggui-ui-feedback-verdict="down"]'));
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({ verdict: 'down' });
  });



  it('collapses into an acknowledgement after a verdict', () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(<UiFeedback onUiFeedback={onUiFeedback} />);
    fireEvent.click(q(container, '[data-ggui-ui-feedback-verdict="up"]'));
    expect(container.querySelector('[data-ggui-ui-feedback-verdict="up"]')).toBeNull();
    expect(container.querySelector('[data-ggui-ui-feedback-thanks]')).not.toBeNull();
  });

  it('dismiss hides the affordance entirely without emitting', () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(<UiFeedback onUiFeedback={onUiFeedback} />);
    fireEvent.click(q(container, '[data-ggui-ui-feedback-dismiss]'));
    expect(container.querySelector('[data-ggui-ui-feedback]')).toBeNull();
    expect(onUiFeedback).not.toHaveBeenCalled();
  });

  it('stays dismissable from the acknowledgement state', () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(<UiFeedback onUiFeedback={onUiFeedback} />);
    fireEvent.click(q(container, '[data-ggui-ui-feedback-verdict="down"]'));
    expect(container.querySelector('[data-ggui-ui-feedback-thanks]')).not.toBeNull();
    fireEvent.click(q(container, '[data-ggui-ui-feedback-dismiss]'));
    expect(container.querySelector('[data-ggui-ui-feedback]')).toBeNull();
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
  });
});

// ── ggui#244 — renderer-threaded affordance (2026-07-30) ──────────────────
//
// Renderer-only hosts (a platform portal whose whole surface IS
// GguiSessionRenderer) own no chrome layer to mount the standalone
// component into, so the renderer accepts the sink directly. The
// zero-config contract must survive the threading: no callback ⇒ the
// renderer gains NO chrome.

import { GguiSessionRenderer } from './DynamicComponent';

describe('GguiSessionRenderer × UiFeedback (#244)', () => {
  const RENDER = {
    componentCode:
      'export default function C() { return React.createElement("p", null, "hi"); }',
  };

  it('renders no feedback affordance when no callback is wired', () => {
    const { container } = render(<GguiSessionRenderer render={RENDER} />);
    expect(container.querySelector('[data-ggui-ui-feedback]')).toBeNull();
  });

  it('mounts the affordance when a callback is wired', () => {
    const { container } = render(
      <GguiSessionRenderer render={RENDER} onUiFeedback={() => {}} />,
    );
    expect(container.querySelector('[data-ggui-ui-feedback]')).not.toBeNull();
  });

  it('stamps sessionId + toolName from the renderer props onto the payload', async () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(
      <GguiSessionRenderer
        render={RENDER}
        onUiFeedback={onUiFeedback}
        feedbackSessionId="sess_42"
        feedbackToolName="ggui_render"
      />,
    );
    const love = container.querySelector<HTMLButtonElement>(
      '[data-ggui-ui-feedback] button',
    );
    expect(love).not.toBeNull();
    love!.click();
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'sess_42',
      toolName: 'ggui_render',
    });
  });
});
