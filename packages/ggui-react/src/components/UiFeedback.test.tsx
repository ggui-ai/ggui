/**
 * UiFeedback — behaviour tests for the render-shell feedback
 * affordance: hidden-without-callback gating, verdict payload shapes
 * (context stamping + omission of absent fields), the Other free-text
 * flow, the post-submit acknowledgement, and dismissal.
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

  it('emits a love verdict stamped with session context', () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(
      <UiFeedback
        onUiFeedback={onUiFeedback}
        sessionId="sess-1"
        toolName="ggui_render"
      />,
    );
    fireEvent.click(q(container, '[data-ggui-ui-feedback-verdict="love"]'));
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({
      verdict: 'love',
      sessionId: 'sess-1',
      toolName: 'ggui_render',
    });
  });

  it('omits context fields the host did not supply', () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(<UiFeedback onUiFeedback={onUiFeedback} />);
    fireEvent.click(q(container, '[data-ggui-ui-feedback-verdict="dislike"]'));
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({ verdict: 'dislike' });
  });

  it('opens the free-text flow on Other and sends the trimmed comment', () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(
      <UiFeedback onUiFeedback={onUiFeedback} sessionId="sess-2" />,
    );
    fireEvent.click(q(container, '[data-ggui-ui-feedback-verdict="other"]'));
    // Verdict buttons collapse into the comment form; nothing emitted yet.
    expect(onUiFeedback).not.toHaveBeenCalled();
    fireEvent.change(q(container, '[data-ggui-ui-feedback-comment]'), {
      target: { value: '  the chart ignored my data  ' },
    });
    fireEvent.submit(q(container, '[data-ggui-ui-feedback-comment-form]'));
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({
      verdict: 'other',
      comment: 'the chart ignored my data',
      sessionId: 'sess-2',
    });
  });

  it('omits a whitespace-only comment from the payload', () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(<UiFeedback onUiFeedback={onUiFeedback} />);
    fireEvent.click(q(container, '[data-ggui-ui-feedback-verdict="other"]'));
    fireEvent.change(q(container, '[data-ggui-ui-feedback-comment]'), { target: { value: '   ' } });
    fireEvent.submit(q(container, '[data-ggui-ui-feedback-comment-form]'));
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({ verdict: 'other' });
  });

  it('collapses into an acknowledgement after a verdict', () => {
    const onUiFeedback = feedbackSink();
    const { container } = render(<UiFeedback onUiFeedback={onUiFeedback} />);
    fireEvent.click(q(container, '[data-ggui-ui-feedback-verdict="love"]'));
    expect(container.querySelector('[data-ggui-ui-feedback-verdict="love"]')).toBeNull();
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
    fireEvent.click(q(container, '[data-ggui-ui-feedback-verdict="dislike"]'));
    expect(container.querySelector('[data-ggui-ui-feedback-thanks]')).not.toBeNull();
    fireEvent.click(q(container, '[data-ggui-ui-feedback-dismiss]'));
    expect(container.querySelector('[data-ggui-ui-feedback]')).toBeNull();
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
  });
});
