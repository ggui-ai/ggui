/**
 * UiFeedback — behaviour tests for the render-shell feedback
 * affordance: hidden-without-callback gating, the two thumb verdicts
 * (context stamping + omission of absent fields), glyph-only a11y
 * labelling, the post-submit acknowledgement, and dismissal.
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

  it('emits an up verdict stamped with session context', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(
      <UiFeedback
        onUiFeedback={onUiFeedback}
        sessionId="sess-1"
        toolName="ggui_render"
      />,
    );
    press(renderer, 'ggui-ui-feedback-verdict-up');
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({
      verdict: 'up',
      sessionId: 'sess-1',
      toolName: 'ggui_render',
    });
  });

  it('renders exactly two glyph verdict buttons with accessible names', () => {
    const renderer = mount(<UiFeedback onUiFeedback={feedbackSink()} />);
    const up = byTestId(renderer, 'ggui-ui-feedback-verdict-up');
    const down = byTestId(renderer, 'ggui-ui-feedback-verdict-down');
    // #653: the words left the row — the name lives in accessibilityLabel.
    expect((up.props as { accessibilityLabel?: string }).accessibilityLabel).toBe(
      'Thumbs up',
    );
    expect(
      (down.props as { accessibilityLabel?: string }).accessibilityLabel,
    ).toBe('Thumbs down');
    // No third verdict, no free-text affordance (founder-scoped to two).
    expect(hasTestId(renderer, 'ggui-ui-feedback-verdict-other')).toBe(false);
    expect(hasTestId(renderer, 'ggui-ui-feedback-comment')).toBe(false);
  });

  it('omits context fields the host did not supply', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(<UiFeedback onUiFeedback={onUiFeedback} />);
    press(renderer, 'ggui-ui-feedback-verdict-down');
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
    expect(onUiFeedback.mock.calls[0]?.[0]).toEqual({ verdict: 'down' });
  });




  it('collapses into an acknowledgement after a verdict', () => {
    const onUiFeedback = feedbackSink();
    const renderer = mount(<UiFeedback onUiFeedback={onUiFeedback} />);
    press(renderer, 'ggui-ui-feedback-verdict-up');
    expect(hasTestId(renderer, 'ggui-ui-feedback-verdict-up')).toBe(false);
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
    press(renderer, 'ggui-ui-feedback-verdict-down');
    expect(hasTestId(renderer, 'ggui-ui-feedback-thanks')).toBe(true);
    press(renderer, 'ggui-ui-feedback-dismiss');
    expect(renderer.toJSON()).toBeNull();
    expect(onUiFeedback).toHaveBeenCalledTimes(1);
  });
});
