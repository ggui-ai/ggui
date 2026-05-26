/**
 * `buildSnapshotPolling` — registry-level polling composition for the
 * iframe-runtime (R6).
 *
 * Replaces the per-handler polling descriptor on
 * `createPropsUpdateHandler`. One URL, one tick interval, one
 * snapshot parser that returns a frame map.
 *
 * These tests pin the closure-based diff detection invariants:
 *   - First poll fires unconditionally (no baseline) → frame.
 *   - Identical second poll → null (whole-envelope short-circuit).
 *   - Changed propsJson → frame; changed stackItemId → frame.
 *   - Missing/malformed slice → empty map (snapshot moved but nothing
 *     dispatchable on props_update).
 *   - lastSequence in the session slice is captured (R7 cursor hand-off).
 */
import { describe, expect, it } from 'vitest';
import { buildSnapshotPolling } from '../snapshot-polling.js';

function sessionSlice(seq: number): unknown {
  return {
    sessionId: 's',
    appId: 'a',
    runtimeUrl: '/_ggui/iframe-runtime.js',
    lastSequence: seq,
  };
}

function envelope(opts: {
  readonly seq?: number;
  readonly stackItemId?: string;
  readonly propsJson?: string;
}): unknown {
  return {
    ...(opts.seq !== undefined
      ? { 'ai.ggui/session': sessionSlice(opts.seq) }
      : {}),
    ...(opts.stackItemId !== undefined || opts.propsJson !== undefined
      ? {
          'ai.ggui/stack-item': {
            ...(opts.stackItemId !== undefined
              ? { stackItemId: opts.stackItemId }
              : {}),
            ...(opts.propsJson !== undefined
              ? { propsJson: opts.propsJson }
              : {}),
          },
        }
      : {}),
  };
}

describe('buildSnapshotPolling', () => {
  it('returns a descriptor with the supplied URL + default interval', () => {
    const desc = buildSnapshotPolling({ url: 'http://ggui.test/state' });
    expect(desc.url).toBe('http://ggui.test/state');
    expect(desc.intervalMs).toBe(2000);
  });

  it('honors a custom intervalMs override', () => {
    const desc = buildSnapshotPolling({
      url: 'http://ggui.test/state',
      intervalMs: 5000,
    });
    expect(desc.intervalMs).toBe(5000);
  });

  it('first parse emits a props_update frame on a fresh snapshot', () => {
    const desc = buildSnapshotPolling({ url: 'http://ggui.test/state' });
    const out = desc.parseSnapshot(
      envelope({ seq: 1, stackItemId: 'item_a', propsJson: '{"count":0}' }),
    );
    expect(out).not.toBeNull();
    expect(out!['props_update']).toEqual({
      type: 'props_update',
      payload: { stackItemId: 'item_a', props: { count: 0 } },
    });
  });

  it('second parse with identical body returns null (whole-envelope short-circuit)', () => {
    const desc = buildSnapshotPolling({ url: 'http://ggui.test/state' });
    const body = envelope({
      seq: 1,
      stackItemId: 'item_a',
      propsJson: '{"count":0}',
    });
    desc.parseSnapshot(body); // prime
    expect(desc.parseSnapshot(body)).toBeNull();
  });

  it('emits a frame when propsJson changes between polls', () => {
    const desc = buildSnapshotPolling({ url: 'http://ggui.test/state' });
    desc.parseSnapshot(
      envelope({ seq: 1, stackItemId: 'item_a', propsJson: '{"count":0}' }),
    );
    const out = desc.parseSnapshot(
      envelope({ seq: 2, stackItemId: 'item_a', propsJson: '{"count":5}' }),
    );
    expect(out!['props_update']).toEqual({
      type: 'props_update',
      payload: { stackItemId: 'item_a', props: { count: 5 } },
    });
  });

  it('emits a frame when stackItemId changes between polls', () => {
    const desc = buildSnapshotPolling({ url: 'http://ggui.test/state' });
    desc.parseSnapshot(
      envelope({ seq: 1, stackItemId: 'item_a', propsJson: '{"x":1}' }),
    );
    const out = desc.parseSnapshot(
      envelope({ seq: 2, stackItemId: 'item_b', propsJson: '{"x":1}' }),
    );
    expect(out!['props_update']).toEqual({
      type: 'props_update',
      payload: { stackItemId: 'item_b', props: { x: 1 } },
    });
  });

  it('returns empty map when snapshot moved but stack-item is missing', () => {
    const desc = buildSnapshotPolling({ url: 'http://ggui.test/state' });
    const out = desc.parseSnapshot(envelope({ seq: 7 }));
    // Snapshot hash changed (seq=7 is new) but no stack-item slice →
    // empty map (no frames to dispatch).
    expect(out).toEqual({});
  });

  it('returns empty map when propsJson is malformed', () => {
    const desc = buildSnapshotPolling({ url: 'http://ggui.test/state' });
    const out = desc.parseSnapshot(
      envelope({
        seq: 1,
        stackItemId: 'item_a',
        propsJson: '{not valid json',
      }),
    );
    expect(out).toEqual({});
  });

  it('returns empty map when propsJson parses to an array or null', () => {
    const desc = buildSnapshotPolling({ url: 'http://ggui.test/state' });
    expect(
      desc.parseSnapshot(
        envelope({
          seq: 1,
          stackItemId: 'item_a',
          propsJson: '[1,2,3]',
        }),
      ),
    ).toEqual({});
    expect(
      desc.parseSnapshot(
        envelope({
          seq: 2,
          stackItemId: 'item_a',
          propsJson: 'null',
        }),
      ),
    ).toEqual({});
  });

  it('returns null when body is not an object', () => {
    const desc = buildSnapshotPolling({ url: 'http://ggui.test/state' });
    expect(desc.parseSnapshot(null)).toBeNull();
    expect(desc.parseSnapshot('not-json')).toBeNull();
  });

  it('accepts a seedLastSequence cursor seed without throwing', () => {
    const desc = buildSnapshotPolling({
      url: 'http://ggui.test/state',
      seedLastSequence: 42,
    });
    // Seed is captured for R7 hand-off; no observable effect on R6
    // snapshot path. Just confirm the descriptor still parses cleanly.
    const out = desc.parseSnapshot(
      envelope({ seq: 43, stackItemId: 'i', propsJson: '{"a":1}' }),
    );
    expect(out!['props_update']).toBeDefined();
  });
});
