/**
 * UiFeedback — behaviour tests for the render-shell feedback
 * affordance: hidden-without-callback gating, verdict payload shapes
 * (context stamping + omission of absent fields), the Other free-text
 * flow, the post-submit acknowledgement, and dismissal.
 *
 * Mirrors `ggui-react/src/components/UiFeedback.test.tsx` on the RN
 * test idiom: react-test-renderer trees, `testID` lookups in place of
 * `data-ggui-ui-feedback*` selectors, and `onPress` / `onChangeText`
 * calls in place of DOM events.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { UiFeedback } from './UiFeedback';
import type { UiFeedbackPayload } from './UiFeedback';

function feedbackSink() {
  return vi.fn<(feedback: UiFeedbackPayload) => void>();
}

function mount(element: React.ReactElement): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element);
  });
  if (!renderer) throw new Error('expected renderer to mount');
  return renderer;
}

/** Strict testID lookup — throws instead of returning undefined. */
function byTestId(renderer: ReactTestRenderer, testID: string) {
  const matches = renderer.root.findAllByProps({ testID });
  const first = matches[0];
  if (!first) throw new Error(`expected element with testID ${testID}`);
  return first;
}

function hasTestId(renderer: ReactTestRenderer, testID: string): boolean {
  return renderer.root.findAllByProps({ testID }).length > 0;
}

function press(renderer: ReactTestRenderer, testID: string): void {
  const el = byTestId(renderer, testID);
  act(() => {
    (el.props as { onPress: () => void }).onPress();
  });
}

describe('UiFeedback', () => {
  it('renders nothing when no onUiFeedback callback is wired', () => {
    const renderer = mount(
      <UiFeedback sessionId="sess-1" toolName="ggui_render" />,
    );
    expect(renderer.toJSON()).toBeNull();
  });

  it('emits a love verdict stamped with session context', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(
      <UiFeedback
        onUiFeedback={onUiFeedback}
        sessionId="sess-1"
        toolName="ggui_render"
      />,
    );
    press(renderer, 'ggui-ui-feedback-verdict-love');
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({
      verdict: 'love',
      sessionId: 'sess-1',
      toolName: 'ggui_render',
    });
  });

  it('omits context fields the host did not supply', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(<UiFeedback onUiFeedback={onUiFeedback} />);
    press(renderer, 'ggui-ui-feedback-verdict-dislike');
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({ verdict: 'dislike' });
  });

  it('opens the free-text flow on Other and sends the trimmed comment', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(
      <UiFeedback onUiFeedback={onUiFeedback} sessionId="sess-2" />,
    );
    press(renderer, 'ggui-ui-feedback-verdict-other');
    // Verdict buttons collapse into the comment form; nothing emitted yet.
    expect(onUiFeedback).not.toHaveBeenCalled();
    const input = byTestId(renderer, 'ggui-ui-feedback-comment');
    act(() => {
      (input.props as { onChangeText: (text: string) => void }).onChangeText(
        '  the chart ignored my data  ',
      );
    });
    press(renderer, 'ggui-ui-feedback-send');
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({
      verdict: 'other',
      comment: 'the chart ignored my data',
      sessionId: 'sess-2',
    });
  });

  it('submits the comment from the keyboard return key too', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(<UiFeedback onUiFeedback={onUiFeedback} />);
    press(renderer, 'ggui-ui-feedback-verdict-other');
    const input = byTestId(renderer, 'ggui-ui-feedback-comment');
    act(() => {
      (input.props as { onChangeText: (text: string) => void }).onChangeText('great');
    });
    act(() => {
      (input.props as { onSubmitEditing: () => void }).onSubmitEditing();
    });
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({
      verdict: 'other',
      comment: 'great',
    });
  });

  it('omits a whitespace-only comment from the payload', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(<UiFeedback onUiFeedback={onUiFeedback} />);
    press(renderer, 'ggui-ui-feedback-verdict-other');
    const input = byTestId(renderer, 'ggui-ui-feedback-comment');
    act(() => {
      (input.props as { onChangeText: (text: string) => void }).onChangeText('   ');
    });
    press(renderer, 'ggui-ui-feedback-send');
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({ verdict: 'other' });
  });

  it('collapses into an acknowledgement after a verdict', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(<UiFeedback onUiFeedback={onUiFeedback} />);
    press(renderer, 'ggui-ui-feedback-verdict-love');
    expect(hasTestId(renderer, 'ggui-ui-feedback-verdict-love')).toBe(false);
    expect(hasTestId(renderer, 'ggui-ui-feedback-thanks')).toBe(true);
  });

  it('dismiss hides the affordance entirely without emitting', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(<UiFeedback onUiFeedback={onUiFeedback} />);
    press(renderer, 'ggui-ui-feedback-dismiss');
    expect(renderer.toJSON()).toBeNull();
    expect(onUiFeedback).not.toHaveBeenCalled();
  });

  it('stays dismissable from the acknowledgement state', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(<UiFeedback onUiFeedback={onUiFeedback} />);
    press(renderer, 'ggui-ui-feedback-verdict-dislike');
    expect(hasTestId(renderer, 'ggui-ui-feedback-thanks')).toBe(true);
    press(renderer, 'ggui-ui-feedback-dismiss');
    expect(renderer.toJSON()).toBeNull();
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
  });
});
