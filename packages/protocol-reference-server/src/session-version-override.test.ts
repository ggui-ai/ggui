/**
 * Per-session `versionOverride` semantics — Slice K.
 *
 * Asserts that {@link SessionStore.setVersionOverride} scoped a
 * version mismatch to one session without leaking to another, and
 * that the WS subscribe handler advertises the per-session value
 * (not the instance-level default) when emitting UPGRADE_REQUIRED.
 *
 * Why this is a separate test file from `conformance.test.ts`: the
 * kit-driven test boots the full conformance catalog (~30s with
 * default observation windows). This file proves the narrow per-
 * session contract directly via the WS wire, runs in <2s, and stays
 * green even if a future kit/fixture change breaks the catalog
 * driver — the per-session contract is package-internal and should
 * be testable without round-tripping through the kit.
 */
import { PROTOCOL_SCHEMA_VERSION } from '@ggui-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { ReferenceServer } from './server.js';

describe('per-session versionOverride', () => {
  let server: ReferenceServer;

  beforeEach(async () => {
    server = new ReferenceServer({ port: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('subscribe to a session with overridden version emits UPGRADE_REQUIRED carrying the override', async () => {
    const sessionId = 'override-target';
    server.sessions.create(sessionId, 'conformance');
    server.sessions.setVersionOverride(sessionId, '99.99-unsupported');

    const frame = await firstFrame(server.baseUrl, {
      type: 'subscribe',
      payload: {
        sessionId,
        appId: 'conformance',
        role: 'user',
        supportedVersions: [PROTOCOL_SCHEMA_VERSION],
      },
      requestId: 'override-target-req',
    });

    expect(frame).toMatchObject({
      type: 'error',
      payload: {
        code: 'UPGRADE_REQUIRED',
        serverVersion: '99.99-unsupported',
      },
      requestId: 'override-target-req',
    });
  });

  it('does NOT leak to a parallel session — that one still gets the canonical advertised version', async () => {
    const overriddenId = 'parallel-override';
    const cleanId = 'parallel-clean';
    server.sessions.create(overriddenId, 'conformance');
    server.sessions.setVersionOverride(overriddenId, '99.99-unsupported');
    // No override on `cleanId` — it should ack the canonical version.

    const frame = await firstFrame(server.baseUrl, {
      type: 'subscribe',
      payload: {
        sessionId: cleanId,
        appId: 'conformance',
        role: 'user',
        supportedVersions: [PROTOCOL_SCHEMA_VERSION],
      },
      requestId: 'parallel-clean-req',
    });

    expect(frame).toMatchObject({
      type: 'ack',
      payload: { serverVersion: PROTOCOL_SCHEMA_VERSION },
      requestId: 'parallel-clean-req',
    });
  });
});

// =============================================================================
// Test helpers
// =============================================================================

/**
 * Open a WS, send the given frame, await the first received frame,
 * close the connection. Narrow to the response shape this test cares
 * about — we don't care about subsequent frames or stream lifecycle.
 */
async function firstFrame(baseUrl: string, send: unknown): Promise<unknown> {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
  return await new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('per-session-override test: no frame received within 2s'));
    }, 2000);
    ws.on('open', () => {
      ws.send(JSON.stringify(send));
    });
    ws.on('message', (raw: Buffer) => {
      clearTimeout(timer);
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        ws.close();
        resolve(parsed);
      } catch (err) {
        ws.close();
        reject(err as Error);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
