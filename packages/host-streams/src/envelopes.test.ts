/**
 * Phase 4a tests: envelope type guards. The runtime manager is a
 * stub at this point so there's no behavior to test there yet.
 * Locking the envelope-recognition logic now protects iframe-runtime
 * + host consumers from drift when phase 4b wires the listener.
 */
import { describe, expect, it } from 'vitest';
import {
  isStreamExtensionEnvelope,
  isStreamFrameNotification,
  isStreamSubscribeNotification,
  type StreamFrameNotification,
  type StreamSubscribeNotification,
} from './envelopes';

describe('isStreamExtensionEnvelope', () => {
  it('accepts every ui/extensions/ggui/stream-* method', () => {
    const methods = [
      'ui/extensions/ggui/stream-subscribe',
      'ui/extensions/ggui/stream-unsubscribe',
      'ui/extensions/ggui/stream-frame',
      'ui/extensions/ggui/stream-error',
    ];
    for (const method of methods) {
      expect(
        isStreamExtensionEnvelope({ jsonrpc: '2.0', method, params: {} }),
        `method ${method} should be recognized`,
      ).toBe(true);
    }
  });

  it('rejects non-2.0 jsonrpc envelopes', () => {
    expect(
      isStreamExtensionEnvelope({
        jsonrpc: '1.0',
        method: 'ui/extensions/ggui/stream-frame',
        params: {},
      }),
    ).toBe(false);
  });

  it('rejects ui/extensions/<other-vendor>/* methods', () => {
    expect(
      isStreamExtensionEnvelope({
        jsonrpc: '2.0',
        method: 'ui/extensions/other-vendor/stream-frame',
        params: {},
      }),
    ).toBe(false);
  });

  it('rejects non-stream ggui methods', () => {
    expect(
      isStreamExtensionEnvelope({
        jsonrpc: '2.0',
        method: 'ui/extensions/ggui/some-other-thing',
        params: {},
      }),
    ).toBe(false);
  });

  it('rejects nullish + non-object values', () => {
    expect(isStreamExtensionEnvelope(null)).toBe(false);
    expect(isStreamExtensionEnvelope(undefined)).toBe(false);
    expect(isStreamExtensionEnvelope('a string')).toBe(false);
    expect(isStreamExtensionEnvelope(42)).toBe(false);
  });
});

describe('isStreamFrameNotification', () => {
  it('narrows to the frame envelope', () => {
    const frame: StreamFrameNotification = {
      jsonrpc: '2.0',
      method: 'ui/extensions/ggui/stream-frame',
      params: {
        sessionId: 'r1',
        channel: 'ticker',
        payload: { price: 42 },
      },
    };
    expect(isStreamFrameNotification(frame)).toBe(true);
    // Type-narrowing check — params.channel is statically known.
    if (isStreamFrameNotification(frame)) {
      expect(frame.params.channel).toBe('ticker');
    }
  });

  it('rejects subscribe envelopes (different method)', () => {
    const sub: StreamSubscribeNotification = {
      jsonrpc: '2.0',
      method: 'ui/extensions/ggui/stream-subscribe',
      params: { sessionId: 'r1', channel: 'ticker', tool: 'fetch_quote' },
    };
    expect(isStreamFrameNotification(sub)).toBe(false);
  });
});

describe('isStreamSubscribeNotification', () => {
  it('narrows to the subscribe envelope', () => {
    const sub: StreamSubscribeNotification = {
      jsonrpc: '2.0',
      method: 'ui/extensions/ggui/stream-subscribe',
      params: {
        sessionId: 'r1',
        channel: 'ticker',
        tool: 'fetch_quote',
        args: { symbol: 'AAPL' },
        pollIntervalMs: 5000,
      },
    };
    expect(isStreamSubscribeNotification(sub)).toBe(true);
  });
});
