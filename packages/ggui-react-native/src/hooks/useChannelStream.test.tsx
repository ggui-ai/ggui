/**
 * useChannelStream (RN) — mirrors the behavioural coverage of the
 * web hook. Drives the in-process `preview-bridge` emitter directly
 * so we exercise the native path without needing a running WebSocket.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { PREVIEW_CHANNEL } from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { useChannelStream } from './useChannelStream';
import {
  __resetPreviewBridgeForTests,
  emitPreviewBridge,
} from '../internal/preview-bridge';

function Consumer({ channel }: { channel: string }): React.ReactElement {
  const { envelopes, complete } = useChannelStream(channel);
  return React.createElement('Consumer', {
    testID: 'consumer',
    'data-count': envelopes.length,
    'data-complete': complete,
    'data-payloads': envelopes.map((e) => JSON.stringify(e.payload)).join('|'),
  });
}

function readProbe(tree: ReactTestRenderer): {
  count: number;
  complete: boolean;
  payloads: string;
} {
  const node = tree.root.findByProps({ testID: 'consumer' });
  const props = node.props as Record<string, unknown>;
  return {
    count: props['data-count'] as number,
    complete: props['data-complete'] as boolean,
    payloads: props['data-payloads'] as string,
  };
}

function makeEnvelope(
  partial: Partial<StreamEnvelope> & { channel: string },
): StreamEnvelope {
  return {
    sessionId: 'sess-1',
    mode: 'append',
    payload: {},
    ...partial,
  };
}

describe('useChannelStream (RN)', () => {
  beforeEach(() => {
    __resetPreviewBridgeForTests();
  });

  it('starts empty', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(Consumer, { channel: PREVIEW_CHANNEL }));
    });
    const probe = readProbe(tree!);
    expect(probe.count).toBe(0);
    expect(probe.complete).toBe(false);
  });

  it('accumulates envelopes for the matching channel in arrival order', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(Consumer, { channel: PREVIEW_CHANNEL }));
    });
    await act(async () => {
      emitPreviewBridge(makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 } }));
      emitPreviewBridge(makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 2 } }));
      emitPreviewBridge(makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 3 } }));
    });
    const probe = readProbe(tree!);
    expect(probe.count).toBe(3);
    expect(probe.payloads).toBe('{"n":1}|{"n":2}|{"n":3}');
  });

  it('ignores envelopes on other channels', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(Consumer, { channel: PREVIEW_CHANNEL }));
    });
    await act(async () => {
      emitPreviewBridge(makeEnvelope({ channel: 'other', payload: { n: 1 } }));
      emitPreviewBridge(
        makeEnvelope({ channel: '_ggui:something-else', payload: { n: 2 } }),
      );
    });
    expect(readProbe(tree!).count).toBe(0);
  });

  it('flips complete latch when any envelope carries complete:true', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(Consumer, { channel: PREVIEW_CHANNEL }));
    });
    await act(async () => {
      emitPreviewBridge(makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 } }));
    });
    expect(readProbe(tree!).complete).toBe(false);

    await act(async () => {
      emitPreviewBridge(
        makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 2 }, complete: true }),
      );
    });
    expect(readProbe(tree!).complete).toBe(true);
  });

  it('complete latch stays sticky', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(Consumer, { channel: PREVIEW_CHANNEL }));
    });
    await act(async () => {
      emitPreviewBridge(
        makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 }, complete: true }),
      );
      emitPreviewBridge(makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 2 } }));
    });
    expect(readProbe(tree!).complete).toBe(true);
  });

  it('resets state when subscribed channel changes', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(Consumer, { channel: PREVIEW_CHANNEL }));
    });
    await act(async () => {
      emitPreviewBridge(makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 } }));
    });
    expect(readProbe(tree!).count).toBe(1);

    await act(async () => {
      tree.update(React.createElement(Consumer, { channel: 'other' }));
    });
    const next = readProbe(tree!);
    expect(next.count).toBe(0);
    expect(next.complete).toBe(false);
  });

  it('unsubscribes on unmount', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(Consumer, { channel: PREVIEW_CHANNEL }));
    });
    await act(async () => {
      emitPreviewBridge(makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 } }));
    });
    expect(readProbe(tree!).count).toBe(1);

    await act(async () => {
      tree!.unmount();
    });
    // After unmount further emits must not throw — listener was torn
    // down by the effect cleanup.
    expect(() => {
      emitPreviewBridge(
        makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 99 } }),
      );
    }).not.toThrow();
  });

  it('isolates listener faults so one throw does not poison siblings', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(Consumer, { channel: PREVIEW_CHANNEL }));
    });
    // A rogue direct listener (not our hook) that throws.
    const unsub = (await import('../internal/preview-bridge')).subscribePreviewBridge(
      () => {
        throw new Error('boom');
      },
    );
    await act(async () => {
      emitPreviewBridge(makeEnvelope({ channel: PREVIEW_CHANNEL, payload: { n: 1 } }));
    });
    // Our hook still saw the emit.
    expect(readProbe(tree!).count).toBe(1);
    unsub();
  });
});
