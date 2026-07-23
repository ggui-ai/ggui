/**
 * WS open-deadline regression test.
 *
 * Nightly run 29995204909 hung g14 for 240s twice because
 * `subscribeWith`'s WS open await had no deadline: an edge-side
 * connect blackhole (socket accepted, 101 upgrade never sent) left the
 * fixture waiting mutely until the caller's test timeout killed it
 * with zero attribution. The open await now has a deadline that
 * terminates the socket and rejects with a named error. This test
 * pins that behavior against a real blackholing TCP server — one that
 * accepts connections and never speaks.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostSimulator } from '../src/host-simulator.js';

let blackhole: Server;
let port: number;
const held = new Set<Socket>();

beforeAll(async () => {
  // Accept TCP connections and never respond — no HTTP, no 101, no
  // close. Exactly the upstream behavior observed in the incident.
  // Track the sockets: `server.close()` waits for live connections,
  // so teardown must destroy the deliberately-held ones first.
  blackhole = createServer((socket) => {
    held.add(socket);
    socket.on('close', () => held.delete(socket));
  });
  await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
  const addr = blackhole.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterAll(async () => {
  for (const socket of held) socket.destroy();
  await new Promise<void>((resolve) => blackhole.close(() => resolve()));
});

describe('subscribeWith WS open deadline', () => {
  it('fails fast with a named error when the upgrade never completes', async () => {
    const host = new HostSimulator({ url: 'http://127.0.0.1:1/unused' });
    const started = Date.now();
    await expect(
      host.subscribeWith(
        {
          sessionId: 'render_blackhole',
          appId: 'app_blackhole',
          runtimeUrl: 'http://127.0.0.1:1/unused-runtime.js',
          wsUrl: `ws://127.0.0.1:${port}/ws`,
          wsToken: 'tok_blackhole',
        },
        { openTimeoutMs: 500 }
      )
    ).rejects.toThrow(/WS open timeout \(500ms\)/);
    // Fail-fast, not test-timeout: well under a second of slack.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
