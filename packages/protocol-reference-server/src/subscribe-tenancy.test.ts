/**
 * SPEC §12.2 subscribe tenancy — the subscribe's `appId` MUST match
 * the GguiSession's bound `appId` or the subscribe fails with the
 * canonical `error` frame, code `APP_MISMATCH` (§12.2.3).
 *
 * The conformance suite (`conformance.test.ts`) grades the rejection
 * end-to-end via the kit's `app-mismatch` fixture. This file pins the
 * package-internal edges around it:
 *
 *   - the mismatch reply echoes the subscribe's `requestId` and emits
 *     NO ack (no subscriber registered);
 *   - a matching appId still acks;
 *   - provision-on-subscribe binds the SUBSCRIBE PAYLOAD's appId — a
 *     regression lock on the create-before-addSubscriber ordering
 *     (`addSubscriber`'s create-if-missing fallback binds the default
 *     app, which would make a fresh render reject the same client's
 *     next subscribe).
 *
 * Mirrors the test-helper pattern from `emit-envelope.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createReferenceConformanceHost } from './conformance-host.js';
import { ReferenceServer } from './server.js';

describe('SPEC §12.2 subscribe tenancy (APP_MISMATCH)', () => {
  let server: ReferenceServer;

  beforeEach(async () => {
    server = new ReferenceServer({ port: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('rejects a subscribe whose appId differs from the bound app with APP_MISMATCH (no ack)', async () => {
    const host = createReferenceConformanceHost({ serverInstance: server });
    await host.dispatchSetup({
      kind: 'create-session',
      sessionId: 'tenancy-1',
      appId: 'app-other',
    });

    const reply = await subscribeOnce(server.baseUrl, {
      sessionId: 'tenancy-1',
      appId: 'conformance',
      requestId: 'tenancy-1-req',
    });

    expect(reply).toEqual({
      type: 'error',
      payload: {
        code: 'APP_MISMATCH',
        message: "GguiSession 'tenancy-1' belongs to a different app",
      },
      requestId: 'tenancy-1-req',
    });
    // The rejected subscribe registered nothing.
    expect(server.renders.get('tenancy-1')?.subscribers.size).toBe(0);
  });

  it('acks a subscribe whose appId matches the bound app', async () => {
    const host = createReferenceConformanceHost({ serverInstance: server });
    await host.dispatchSetup({
      kind: 'create-session',
      sessionId: 'tenancy-2',
      appId: 'app-other',
    });

    const reply = await subscribeOnce(server.baseUrl, {
      sessionId: 'tenancy-2',
      appId: 'app-other',
      requestId: 'tenancy-2-req',
    });

    expect(reply).toMatchObject({ type: 'ack', requestId: 'tenancy-2-req' });
  });

  it('provision-on-subscribe binds the subscribe payload appId — the same appId re-subscribes cleanly', async () => {
    // No create-session directive: the first subscribe provisions.
    const first = await subscribeOnce(server.baseUrl, {
      sessionId: 'tenancy-3',
      appId: 'app-fresh',
      requestId: 'tenancy-3-req-1',
    });
    expect(first).toMatchObject({ type: 'ack' });
    expect(server.renders.get('tenancy-3')?.appId).toBe('app-fresh');

    // Regression lock: before the create-before-addSubscriber ordering
    // fix, the provisioned render was bound to the DEFAULT app and this
    // re-subscribe failed APP_MISMATCH against the very client that
    // created it.
    const second = await subscribeOnce(server.baseUrl, {
      sessionId: 'tenancy-3',
      appId: 'app-fresh',
      requestId: 'tenancy-3-req-2',
    });
    expect(second).toMatchObject({ type: 'ack' });

    // And a DIFFERENT app is still rejected.
    const third = await subscribeOnce(server.baseUrl, {
      sessionId: 'tenancy-3',
      appId: 'app-imposter',
      requestId: 'tenancy-3-req-3',
    });
    expect(third).toMatchObject({
      type: 'error',
      payload: { code: 'APP_MISMATCH' },
    });
  });
});

// =============================================================================
// Test helpers
// =============================================================================

/**
 * Open a WS, send one `subscribe` frame, resolve with the FIRST frame
 * the server replies (ack or error), then close. The tenancy contract
 * is a single request/reply exchange, so one frame is the whole
 * observable surface.
 */
async function subscribeOnce(
  baseUrl: string,
  payload: { sessionId: string; appId: string; requestId: string },
): Promise<unknown> {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
  return await new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const ceiling = setTimeout(() => {
      ws.close();
      reject(new Error('subscribe-tenancy test: no reply within 2s'));
    }, 2000);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          payload: {
            sessionId: payload.sessionId,
            appId: payload.appId,
            role: 'user',
          },
          requestId: payload.requestId,
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
      clearTimeout(ceiling);
      ws.close();
      resolve(parsed);
    });

    ws.on('error', (err) => {
      clearTimeout(ceiling);
      reject(err);
    });
  });
}
