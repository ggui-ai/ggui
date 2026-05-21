/**
 * Tests for the host-context emitter (Slice A, 2026-05-17).
 *
 * Three behavioral concerns:
 *
 *   1. seed() emits the initial projection through the send seam.
 *   2. host-context-changed notifications merge into the held value
 *      and re-emit on change; no-op when nothing projection-visible
 *      changed.
 *   3. detach() removes the listener and clears module state cleanly.
 *
 * Module-level state means tests MUST `detach()` in afterEach. The
 * happy-dom / jsdom environment supplies the window + MessageEvent
 * primitives the emitter listens for.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostContextObservedPayload } from '@ggui-ai/protocol';
import {
  _peekCurrent,
  attachListener,
  detach,
  seed,
  subscribeLocal,
} from '../host-context-emitter.js';

type SentMsg = {
  readonly type: 'host_context_observed';
  readonly payload: HostContextObservedPayload;
};

function dispatchHostContextChanged(params: unknown): void {
  const ev = new MessageEvent('message', {
    data: {
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params,
    },
  });
  window.dispatchEvent(ev);
}

describe('host-context-emitter', () => {
  let sent: SentMsg[];
  const send = (msg: SentMsg) => {
    sent.push(msg);
  };

  beforeEach(() => {
    sent = [];
  });

  afterEach(() => {
    detach();
  });

  it('emits the initial projection on first seed', () => {
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'inline' },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'host_context_observed',
      payload: {
        sessionId: 'sess_1',
        hostContext: { currentDisplayMode: 'inline' },
      },
    });
  });

  it('re-seed with the same projection does NOT emit again', () => {
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'inline' },
    });
    expect(sent).toHaveLength(1);
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'inline' },
    });
    expect(sent).toHaveLength(1);
  });

  it('re-seed with a DIFFERENT projection emits', () => {
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'inline' },
    });
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'fullscreen' },
    });
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.hostContext).toEqual({
      currentDisplayMode: 'fullscreen',
    });
  });

  it('emits on host-context-changed when projection-visible field changes', () => {
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'inline' },
    });
    attachListener();
    dispatchHostContextChanged({ displayMode: 'fullscreen' });
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.hostContext.currentDisplayMode).toBe('fullscreen');
  });

  it('merges partial updates into the held projection', () => {
    seed({
      sessionId: 'sess_1',
      send,
      initial: {
        currentDisplayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
        platform: 'desktop',
      },
    });
    attachListener();
    // Partial update: only displayMode changes; platform + available
    // should survive the merge.
    dispatchHostContextChanged({ displayMode: 'fullscreen' });
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.hostContext).toEqual({
      currentDisplayMode: 'fullscreen',
      availableDisplayModes: ['inline', 'fullscreen'],
      platform: 'desktop',
    });
  });

  it('suppresses no-op host-context-changed (nothing projection-visible changed)', () => {
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'inline' },
    });
    attachListener();
    // Notification carries a field ggui doesn't project (theme).
    // Should not emit since the projection is unchanged.
    dispatchHostContextChanged({ theme: 'dark' });
    expect(sent).toHaveLength(1);
  });

  it('ignores non-notification messages', () => {
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'inline' },
    });
    attachListener();
    // Wrong method.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          jsonrpc: '2.0',
          method: 'ui/notifications/initialized',
          params: {},
        },
      }),
    );
    // Non-object payload.
    window.dispatchEvent(new MessageEvent('message', { data: 'hello' }));
    // Notification with malformed params.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          method: 'ui/notifications/host-context-changed',
          params: null,
        },
      }),
    );
    expect(sent).toHaveLength(1);
  });

  it('detach() removes the listener and clears state', () => {
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'inline' },
    });
    attachListener();
    detach();
    dispatchHostContextChanged({ displayMode: 'fullscreen' });
    // No emit after detach — listener was removed AND state was cleared.
    expect(sent).toHaveLength(1);
    expect(_peekCurrent()).toBeUndefined();
  });

  it('detach() also clears local subscribers (test isolation)', () => {
    const received: unknown[] = [];
    subscribeLocal((p) => received.push(p));
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'inline' },
    });
    // Subscriber fired on seed.
    expect(received).toHaveLength(1);
    detach();
    // Re-seed in a fresh "scenario" — the OLD subscriber MUST NOT
    // fire (it would, if detach didn't clear localSubscribers).
    seed({
      sessionId: 'sess_2',
      send,
      initial: { currentDisplayMode: 'fullscreen' },
    });
    expect(received).toHaveLength(1);
  });

  it('attachListener() before seed() is a no-op', () => {
    attachListener();
    // No seed yet — listener bail at the `state === null` guard.
    dispatchHostContextChanged({ displayMode: 'fullscreen' });
    expect(sent).toHaveLength(0);
  });

  it('swallows errors from the send seam (fire-and-forget posture)', () => {
    const throwingSend: typeof send = () => {
      throw new Error('WS detached');
    };
    expect(() =>
      seed({
        sessionId: 'sess_1',
        send: throwingSend,
        initial: { currentDisplayMode: 'inline' },
      }),
    ).not.toThrow();
  });

  it('attaches listener idempotently (duplicate calls do not register twice)', () => {
    seed({
      sessionId: 'sess_1',
      send,
      initial: { currentDisplayMode: 'inline' },
    });
    attachListener();
    attachListener(); // duplicate
    attachListener(); // duplicate

    dispatchHostContextChanged({ displayMode: 'fullscreen' });
    // Single emit despite three attachListener() calls — only one
    // registered listener.
    expect(sent).toHaveLength(2);
  });
});
