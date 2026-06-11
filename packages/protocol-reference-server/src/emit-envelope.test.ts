/**
 * `emit-envelope` ConformanceHost directive.
 *
 * Asserts that the directive injects a wire-format-wrapped envelope
 * into the named render's subscriber set, and that the receiving WS
 * client observes the canonical SPEC §12.2 channel-3 delivery frame
 * `{type:'data', payload: StreamEnvelope}` — channel + body on the
 * protocol's envelope shape, with a per-render monotonic `seq` and
 * the render's advertised `schemaVersion` stamped by the host.
 *
 * Why this is a separate test file from `conformance.test.ts`:
 * `emit-envelope` has no kit fixture graded over pure WS today (the
 * only consumer — `props-update-roundtrip` — asserts on rendered DOM
 * and skips as Path-B). This file proves the host's directive
 * contract directly, runs in <2s, and stays green even if a future
 * kit fixture lands on the directive — the host-level contract is
 * package-internal and should be testable without round-tripping
 * through the kit.
 *
 * Mirrors the test-helper pattern from `render-version-override.test.ts`.
 *
 * Wire-field note: subscribes carry the canonical render-identity
 * field `sessionId` on the wire.
 */
import {
  DEFAULT_STREAM_CHANNEL_MODE,
  PROTOCOL_SCHEMA_VERSION,
} from '@ggui-ai/protocol';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';

import { createReferenceConformanceHost } from './conformance-host.js';
import { isRecord } from './is-record.js';
import { ReferenceServer } from './server.js';

describe('emit-envelope ConformanceHost directive', () => {
  let server: ReferenceServer;

  beforeEach(async () => {
    server = new ReferenceServer({ port: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('injects a canonical data frame into a subscribed render and the WS client observes it', async () => {
    const sessionId = 'emit-target';
    const host = createReferenceConformanceHost({ serverInstance: server });

    // Fixture-canonical order: create-session → (client subscribes) →
    // emit-envelope. The `lastCreatedSessionId()` scoping convention
    // requires create-session before the directive lands.
    await host.dispatchSetup({ kind: 'create-session', sessionId });

    // Subscribe a real WS client + capture frames after the ack.
    const observed = await captureFramesAfterAck(server.baseUrl, sessionId, async () => {
      // Triggered AFTER the subscribe ack lands so the subscriber set
      // is populated when the directive fans out.
      await host.dispatchSetup({
        kind: 'emit-envelope',
        channel: 'demo:counter',
        payload: { count: 7, label: 'hello' },
      });
    });

    // First frame after ack should be the injected envelope — the
    // exact SPEC §12.2 `{type:'data', payload: StreamEnvelope}` wire
    // shape, pinned field-by-field:
    //   - `mode` is the protocol's declared default (the reference
    //     server declares no streamSpec to override it per-channel);
    //   - `seq` starts at 1 — first outbound delivery on this render;
    //   - `schemaVersion` is the version the server advertises for
    //     this render (canonical default here — no override directive
    //     ran).
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({
      type: 'data',
      payload: {
        sessionId,
        channel: 'demo:counter',
        mode: DEFAULT_STREAM_CHANNEL_MODE,
        payload: { count: 7, label: 'hello' },
        seq: 1,
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
      },
    });
  });

  it('stamps a per-render monotonic seq across successive emissions', async () => {
    const sessionId = 'emit-seq';
    const host = createReferenceConformanceHost({ serverInstance: server });
    await host.dispatchSetup({ kind: 'create-session', sessionId });

    const observed = await captureFramesAfterAck(server.baseUrl, sessionId, async () => {
      await host.dispatchSetup({
        kind: 'emit-envelope',
        channel: 'demo:counter',
        payload: { tick: 1 },
      });
      await host.dispatchSetup({
        kind: 'emit-envelope',
        channel: 'demo:counter',
        payload: { tick: 2 },
      });
    });

    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({
      type: 'data',
      payload: { sessionId, seq: 1, payload: { tick: 1 } },
    });
    expect(observed[1]).toMatchObject({
      type: 'data',
      payload: { sessionId, seq: 2, payload: { tick: 2 } },
    });
  });

  it('rejects a payload that is not representable as a JSON value', async () => {
    const host = createReferenceConformanceHost({ serverInstance: server });
    await host.dispatchSetup({ kind: 'create-session', sessionId: 'bad-payload' });
    await expect(
      host.dispatchSetup({
        kind: 'emit-envelope',
        channel: 'demo:counter',
        // Functions can't ride a StreamEnvelope — the host must reject
        // loudly instead of serializing to a hole.
        payload: { onTick: () => 7 },
      }),
    ).rejects.toThrow(/JSON value/);
  });

  it('rejects directive without channel', async () => {
    const host = createReferenceConformanceHost({ serverInstance: server });
    await host.dispatchSetup({ kind: 'create-session', sessionId: 'no-channel' });
    await expect(
      host.dispatchSetup({
        // Channel deliberately empty — directive must reject.
        kind: 'emit-envelope',
        channel: '',
        payload: {},
      }),
    ).rejects.toThrow(/missing channel/);
  });

  it('rejects directive when no render has been created yet', async () => {
    const host = createReferenceConformanceHost({ serverInstance: server });
    await expect(
      host.dispatchSetup({
        kind: 'emit-envelope',
        channel: 'demo:counter',
        payload: { x: 1 },
      }),
    ).rejects.toThrow(/before create-session/);
  });

  it('no-ops (warns) when the render has no subscribers — directive resolves, no throw', async () => {
    const host = createReferenceConformanceHost({ serverInstance: server });
    await host.dispatchSetup({ kind: 'create-session', sessionId: 'no-subs' });

    const warnSpy = jestLikeWarnSpy();
    try {
      // Directive should resolve without throwing — the unobservability
      // of the injection is a fixture concern, not a host failure.
      await host.dispatchSetup({
        kind: 'emit-envelope',
        channel: 'demo:counter',
        payload: { x: 1 },
      });
    } finally {
      warnSpy.restore();
    }

    expect(warnSpy.calls.length).toBe(1);
    expect(warnSpy.calls[0]).toMatch(/no subscribers/);
  });
});

// =============================================================================
// Test helpers
// =============================================================================

/**
 * Open a WS, send a `subscribe` frame for `sessionId`, await the ack,
 * trigger `afterAck` (which is expected to cause a server-side
 * frame to fan out to this subscriber), then collect every subsequent
 * frame that lands within a short observation window. Close + return
 * the collected frames.
 *
 * Two-phase capture (ack vs post-ack) is the cleanest way to assert
 * "the injected envelope arrived AFTER subscribe, as a consequence of
 * the directive": the ack frame is filtered out so the assertion is
 * about the directive's effect, not the subscribe round-trip.
 */
async function captureFramesAfterAck(
  baseUrl: string,
  sessionId: string,
  afterAck: () => Promise<void>,
): Promise<readonly unknown[]> {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
  return await new Promise<readonly unknown[]>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const post: unknown[] = [];
    let acked = false;
    let observationTimer: NodeJS.Timeout | null = null;

    const cleanupAndResolve = (): void => {
      if (observationTimer !== null) clearTimeout(observationTimer);
      ws.close();
      resolve(post);
    };

    const armObservationWindow = (): void => {
      // 200ms is plenty for the directive's synchronous fan-out — the
      // injection runs on the same tick as `dispatchSetup`'s resolve.
      observationTimer = setTimeout(cleanupAndResolve, 200);
    };

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          payload: { sessionId, appId: 'conformance', role: 'user' },
          requestId: 'capture-req',
        }),
      );
    });

    ws.on('message', (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!acked && isAck(parsed)) {
        acked = true;
        // Fire the trigger that should cause the injection. After it
        // resolves, arm a short observation window to collect any
        // post-ack frames.
        afterAck()
          .then(() => {
            armObservationWindow();
          })
          .catch(reject);
        return;
      }
      if (acked) {
        post.push(parsed);
      }
    });

    ws.on('error', (err) => {
      if (observationTimer !== null) clearTimeout(observationTimer);
      reject(err);
    });

    // Hard ceiling so a hung test doesn't run forever.
    setTimeout(() => {
      if (!acked) {
        ws.close();
        reject(new Error('emit-envelope test: never received ack within 2s'));
      }
    }, 2000);
  });
}

function isAck(frame: unknown): boolean {
  return isRecord(frame) && frame['type'] === 'ack';
}

/**
 * Minimal spy on `console.warn` — the package has no logger, and
 * vitest's `vi.spyOn` would pull a global mock-state that interacts
 * weirdly with parallel test files. Local restore-on-finally keeps
 * scope tight.
 */
function jestLikeWarnSpy(): {
  readonly calls: readonly string[];
  readonly restore: () => void;
} {
  const calls: string[] = [];
  const original = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    calls.push(args.map(String).join(' '));
  };
  return {
    calls,
    restore: () => {
      console.warn = original;
    },
  };
}
