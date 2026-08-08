/**
 * `subscribeWith({fromSeq})` wire-shape regression test.
 *
 * #435 T6 needs `subscribeWith` to carry a resume cursor on the
 * `subscribe` payload so a second WS connection can replay everything
 * a live `ggui_emit` already delivered. This pins the wire contract at
 * the unit level — a real `ws` server inspecting the raw frame — so a
 * future edit to the payload-build in `host-simulator.ts` can't drop
 * the field silently. The end-to-end replay behavior (server actually
 * honoring `fromSeq`) is covered by the hosted lane in
 * `cloud/e2e/scenarios/trier/t6-emit-delivery.spec.ts`; this test only
 * pins what the simulator PUTS ON THE WIRE.
 */
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostSimulator } from '../src/host-simulator.js';

let wss: WebSocketServer;
let port: number;
let received: Array<{ type?: unknown; payload?: Record<string, unknown> }>;

beforeEach(async () => {
  received = [];
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const addr = wss.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
  wss.on('connection', (socket: ServerSocket) => {
    socket.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as {
        type?: unknown;
        payload?: Record<string, unknown>;
      };
      received.push(parsed);
      socket.send(JSON.stringify({ type: 'ack', payload: { sequence: 0 } }));
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

describe('subscribeWith — fromSeq on the subscribe payload', () => {
  it('omits fromSeq from the wire payload when not passed', async () => {
    const host = new HostSimulator({ url: 'http://127.0.0.1:1/unused' });
    const { ack } = await host.subscribeWith({
      sessionId: 'render_fresh',
      appId: 'app_fresh',
      runtimeUrl: 'http://127.0.0.1:1/unused-runtime.js',
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      wsToken: 'tok_fresh',
    });
    expect(ack.kind).toBe('ack');
    expect(received).toHaveLength(1);
    expect(received[0]?.payload).not.toHaveProperty('fromSeq');
  });

  it('spreads fromSeq onto the wire payload when passed, including 0', async () => {
    const host = new HostSimulator({ url: 'http://127.0.0.1:1/unused' });
    const { ack } = await host.subscribeWith(
      {
        sessionId: 'render_resume',
        appId: 'app_resume',
        runtimeUrl: 'http://127.0.0.1:1/unused-runtime.js',
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        wsToken: 'tok_resume',
      },
      { fromSeq: 0 },
    );
    expect(ack.kind).toBe('ack');
    expect(received).toHaveLength(1);
    expect(received[0]?.payload?.['fromSeq']).toBe(0);
  });
});
