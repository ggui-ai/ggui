/**
 * Code-delivery event registry.
 *
 * Two things are pinned. The EVENT NAMES as wire literals, because an
 * operator's alert filter matches the string and a rename that only
 * updated the const would silently stop matching. And the PAYLOAD
 * `liveChannelWired`, which is the field that separates "slower first
 * paint" from "this envelope cannot mount" — an emitter that dropped
 * it would leave both failures looking identical in the log.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  CODE_DELIVERY_EVENTS,
  reportRenderCodeWriteFailed,
} from './code-delivery-events.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The single warn line this module emits, parsed. */
function emitAndRead(
  failure: Parameters<typeof reportRenderCodeWriteFailed>[0],
): {
  readonly msg: string;
  readonly sessionId: string;
  readonly appId: string;
  readonly liveChannelWired: boolean;
  readonly error: string;
  readonly errorName?: string;
} {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  reportRenderCodeWriteFailed(failure);
  const [line] = warn.mock.calls[0] ?? [];
  if (typeof line !== 'string') {
    throw new Error('expected one structured warn line, got none');
  }
  return JSON.parse(line);
}

describe('CODE_DELIVERY_EVENTS — the registry', () => {
  it('pins each event to its exact wire literal', () => {
    expect(CODE_DELIVERY_EVENTS.renderCodeWriteFailed).toBe(
      'render_code_write_failed',
    );
  });

  it('maps every key to a distinct value — one key per emitted name', () => {
    const values = Object.values(CODE_DELIVERY_EVENTS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('contains exactly these events and no others', () => {
    // Spelled as a literal array rather than derived from the registry:
    // rewriting this to `Object.values(...)` on both sides would make
    // the assertion vacuous, which is the whole failure mode it guards.
    expect(Object.values(CODE_DELIVERY_EVENTS).sort()).toEqual([
      'render_code_b64_over_cap',
      'render_code_write_failed',
    ]);
  });
});

describe('reportRenderCodeWriteFailed', () => {
  it('emits one structured line naming the render and the store error', () => {
    const event = emitAndRead({
      sessionId: 'render-1',
      appId: 'app-1',
      liveChannelWired: false,
      cause: new TypeError('code store offline'),
    });
    expect(event.msg).toBe('render_code_write_failed');
    expect(event.sessionId).toBe('render-1');
    expect(event.appId).toBe('app-1');
    expect(event.error).toBe('code store offline');
    expect(event.errorName).toBe('TypeError');
  });

  it('carries the live-channel posture — the severity of the loss', () => {
    // Same failure, two deployments, two different consequences. An
    // event that could not tell them apart would be untriageable.
    expect(
      emitAndRead({
        sessionId: 'render-1',
        appId: 'app-1',
        liveChannelWired: true,
        cause: new Error('down'),
      }).liveChannelWired,
    ).toBe(true);
    expect(
      emitAndRead({
        sessionId: 'render-1',
        appId: 'app-1',
        liveChannelWired: false,
        cause: new Error('down'),
      }).liveChannelWired,
    ).toBe(false);
  });

  it('records a non-Error throw rather than dropping it', () => {
    // A store that rejects with a string still cost the render its
    // static channel; an emitter that only handled `Error` would log
    // an empty reason for the case hardest to diagnose.
    const event = emitAndRead({
      sessionId: 'render-1',
      appId: 'app-1',
      liveChannelWired: false,
      cause: 'disk full',
    });
    expect(event.error).toBe('disk full');
    expect(event.errorName).toBeUndefined();
  });
});
