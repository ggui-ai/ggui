/**
 * useChannelStream — internal seam covered by a handful of focused
 * behaviour tests. Not a public API, but we want confidence that the
 * filter / accumulation / complete-latch semantics match what
 * ProvisionalRenderer is going to lean on.
 */
import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import { BRIDGE_EVENTS, PREVIEW_CHANNEL } from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { useChannelStream } from './useChannelStream.js';

/** Tiny consumer that surfaces the hook's state as DOM. */
function Consumer({ channel }: { channel: string }) {
  const { envelopes, complete } = useChannelStream(channel);
  return (
    <div>
      <div data-testid="count">{envelopes.length}</div>
      <div data-testid="complete">{complete ? 'true' : 'false'}</div>
      <ul data-testid="payloads">
        {envelopes.map((env, i) => (
          <li key={i}>{JSON.stringify(env.payload)}</li>
        ))}
      </ul>
    </div>
  );
}

function dispatchEnvelope(envelope: Partial<StreamEnvelope> & { channel: string }): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(BRIDGE_EVENTS.AGENT_DATA, {
        detail: {
          renderId: 's1',
          mode: 'append',
          payload: {},
          ...envelope,
        },
      }),
    );
  });
}

describe('useChannelStream', () => {
  it('starts empty', () => {
    const { getByTestId } = render(<Consumer channel={PREVIEW_CHANNEL} />);
    expect(getByTestId('count').textContent).toBe('0');
    expect(getByTestId('complete').textContent).toBe('false');
  });

  it('accumulates envelopes for the matching channel in arrival order', () => {
    const { getByTestId } = render(<Consumer channel={PREVIEW_CHANNEL} />);
    dispatchEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 } });
    dispatchEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 2 } });
    dispatchEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 3 } });
    expect(getByTestId('count').textContent).toBe('3');
    const items = Array.from(
      getByTestId('payloads').querySelectorAll('li'),
    ).map((li) => li.textContent);
    expect(items).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  it('ignores envelopes on other channels', () => {
    const { getByTestId } = render(<Consumer channel={PREVIEW_CHANNEL} />);
    dispatchEnvelope({ channel: 'other', payload: { n: 1 } });
    dispatchEnvelope({ channel: '_ggui:something-else', payload: { n: 2 } });
    expect(getByTestId('count').textContent).toBe('0');
  });

  it('flips complete latch when any envelope has complete:true', () => {
    const { getByTestId } = render(<Consumer channel={PREVIEW_CHANNEL} />);
    dispatchEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 } });
    expect(getByTestId('complete').textContent).toBe('false');
    dispatchEnvelope({
      channel: PREVIEW_CHANNEL,
      payload: { n: 2 },
      complete: true,
    });
    expect(getByTestId('complete').textContent).toBe('true');
  });

  it('complete latch stays sticky across further envelopes', () => {
    const { getByTestId } = render(<Consumer channel={PREVIEW_CHANNEL} />);
    dispatchEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 }, complete: true });
    dispatchEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 2 } });
    expect(getByTestId('complete').textContent).toBe('true');
  });

  it('resets state when the subscribed channel changes', () => {
    const { getByTestId, rerender } = render(
      <Consumer channel={PREVIEW_CHANNEL} />,
    );
    dispatchEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 } });
    expect(getByTestId('count').textContent).toBe('1');

    rerender(<Consumer channel="other" />);
    expect(getByTestId('count').textContent).toBe('0');
    expect(getByTestId('complete').textContent).toBe('false');
  });

  it('unsubscribes on unmount', () => {
    const { getByTestId, unmount } = render(
      <Consumer channel={PREVIEW_CHANNEL} />,
    );
    dispatchEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 } });
    expect(getByTestId('count').textContent).toBe('1');

    unmount();
    // After unmount the listener is removed; dispatching shouldn't
    // throw or leak state into a remount with fresh internal state.
    expect(() =>
      dispatchEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 99 } }),
    ).not.toThrow();
  });

  it('ignores envelopes whose detail is missing or the wrong shape', () => {
    const { getByTestId } = render(<Consumer channel={PREVIEW_CHANNEL} />);
    act(() => {
      // No detail at all — should not crash the reducer.
      window.dispatchEvent(new CustomEvent(BRIDGE_EVENTS.AGENT_DATA));
    });
    expect(getByTestId('count').textContent).toBe('0');
  });
});
