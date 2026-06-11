/**
 * useChannelStream — internal seam covered by a handful of focused
 * behaviour tests. Not a public API, but we want confidence that the
 * filter / accumulation / complete-latch / replay semantics match what
 * ProvisionalRenderer is going to lean on.
 *
 * Envelopes are injected by emitting on a `StreamBus` provided through
 * `StreamBusContext` — exactly the wiring `<GguiRender>` establishes —
 * so the tests exercise the same contract as production, including the
 * reserved-channel replay ring for late subscribers.
 */
import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import { PREVIEW_CHANNEL } from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { StreamBus } from '@ggui-ai/wire';
import { StreamBusContext } from '../internal/stream-bus-context.js';
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

function renderWithBus(bus: StreamBus, channel: string) {
  return render(
    <StreamBusContext.Provider value={bus}>
      <Consumer channel={channel} />
    </StreamBusContext.Provider>,
  );
}

function makeEnvelope(
  envelope: Partial<StreamEnvelope> & { channel: string },
): StreamEnvelope {
  return {
    sessionId: 's1',
    mode: 'append',
    payload: {},
    ...envelope,
  };
}

function emitEnvelope(
  bus: StreamBus,
  envelope: Partial<StreamEnvelope> & { channel: string },
): void {
  act(() => {
    bus.emit(makeEnvelope(envelope));
  });
}

describe('useChannelStream', () => {
  it('starts empty', () => {
    const { getByTestId } = renderWithBus(new StreamBus(), PREVIEW_CHANNEL);
    expect(getByTestId('count').textContent).toBe('0');
    expect(getByTestId('complete').textContent).toBe('false');
  });

  it('accumulates envelopes for the matching channel in arrival order', () => {
    const bus = new StreamBus();
    const { getByTestId } = renderWithBus(bus, PREVIEW_CHANNEL);
    emitEnvelope(bus, { channel: PREVIEW_CHANNEL, payload: { n: 1 } });
    emitEnvelope(bus, { channel: PREVIEW_CHANNEL, payload: { n: 2 } });
    emitEnvelope(bus, { channel: PREVIEW_CHANNEL, payload: { n: 3 } });
    expect(getByTestId('count').textContent).toBe('3');
    const items = Array.from(
      getByTestId('payloads').querySelectorAll('li'),
    ).map((li) => li.textContent);
    expect(items).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  it('ignores envelopes on other channels', () => {
    const bus = new StreamBus();
    const { getByTestId } = renderWithBus(bus, PREVIEW_CHANNEL);
    emitEnvelope(bus, { channel: 'other', payload: { n: 1 } });
    emitEnvelope(bus, { channel: '_ggui:something-else', payload: { n: 2 } });
    expect(getByTestId('count').textContent).toBe('0');
  });

  it('replays buffered reserved-channel envelopes to a LATE subscriber (the ack → mount race)', () => {
    // The F11 fix this wiring exists for: `_ggui:preview` frames that
    // arrived BEFORE the consumer mounted (between the WS ack and the
    // ProvisionalRenderer's post-commit effect) replay from the bus's
    // bounded ring instead of vanishing.
    const bus = new StreamBus();
    bus.emit(makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 } }));
    bus.emit(makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 2 } }));

    const { getByTestId } = renderWithBus(bus, PREVIEW_CHANNEL);
    expect(getByTestId('count').textContent).toBe('2');
    const items = Array.from(
      getByTestId('payloads').querySelectorAll('li'),
    ).map((li) => li.textContent);
    expect(items).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('does not replay non-reserved channels to late subscribers', () => {
    // Agent-declared channels are server-replayed via streamSpec
    // policy; the bus must not double-deliver their history.
    const bus = new StreamBus();
    bus.emit(makeEnvelope({ channel: 'progress', payload: { n: 1 } }));
    const { getByTestId } = renderWithBus(bus, 'progress');
    expect(getByTestId('count').textContent).toBe('0');
  });

  it('flips complete latch when any envelope has complete:true', () => {
    const bus = new StreamBus();
    const { getByTestId } = renderWithBus(bus, PREVIEW_CHANNEL);
    emitEnvelope(bus, { channel: PREVIEW_CHANNEL, payload: { n: 1 } });
    expect(getByTestId('complete').textContent).toBe('false');
    emitEnvelope(bus, {
      channel: PREVIEW_CHANNEL,
      payload: { n: 2 },
      complete: true,
    });
    expect(getByTestId('complete').textContent).toBe('true');
  });

  it('complete latch stays sticky across further envelopes', () => {
    const bus = new StreamBus();
    const { getByTestId } = renderWithBus(bus, PREVIEW_CHANNEL);
    emitEnvelope(bus, { channel: PREVIEW_CHANNEL, payload: { n: 1 }, complete: true });
    emitEnvelope(bus, { channel: PREVIEW_CHANNEL, payload: { n: 2 } });
    expect(getByTestId('complete').textContent).toBe('true');
  });

  it('resets state when the subscribed channel changes', () => {
    const bus = new StreamBus();
    const { getByTestId, rerender } = render(
      <StreamBusContext.Provider value={bus}>
        <Consumer channel={PREVIEW_CHANNEL} />
      </StreamBusContext.Provider>,
    );
    emitEnvelope(bus, { channel: PREVIEW_CHANNEL, payload: { n: 1 } });
    expect(getByTestId('count').textContent).toBe('1');

    rerender(
      <StreamBusContext.Provider value={bus}>
        <Consumer channel="other" />
      </StreamBusContext.Provider>,
    );
    expect(getByTestId('count').textContent).toBe('0');
    expect(getByTestId('complete').textContent).toBe('false');
  });

  it('unsubscribes on unmount', () => {
    const bus = new StreamBus();
    const { getByTestId, unmount } = renderWithBus(bus, PREVIEW_CHANNEL);
    emitEnvelope(bus, { channel: PREVIEW_CHANNEL, payload: { n: 1 } });
    expect(getByTestId('count').textContent).toBe('1');

    unmount();
    // After unmount the listener is removed; emitting shouldn't throw
    // or leak state into a remount with fresh internal state.
    expect(() =>
      emitEnvelope(bus, { channel: PREVIEW_CHANNEL, payload: { n: 99 } }),
    ).not.toThrow();
  });

  it('stays on the empty state outside a <GguiRender> (no bus in context)', () => {
    // Standalone preview mounts have no live channel — no frames to
    // deliver. The hook must not crash; it just never accumulates.
    const { getByTestId } = render(<Consumer channel={PREVIEW_CHANNEL} />);
    expect(getByTestId('count').textContent).toBe('0');
    expect(getByTestId('complete').textContent).toBe('false');
  });
});
