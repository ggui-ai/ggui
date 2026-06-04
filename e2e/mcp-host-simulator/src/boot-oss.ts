/**
 * Boot a local OSS `createGguiServer` factory on an ephemeral port —
 * the standard fixture for Tier 2 host-simulator tests that don't need
 * a remote endpoint.
 *
 * Returns the URL + a close function. Tests typically pair this with
 * `HostSimulator` and tear both down in `afterEach`.
 *
 * Defaults:
 *   - `mcpApps: true` + `wsTokenSecret` set so resourceUri pre-fetch
 *     + bootstrap-token mint paths fire end-to-end. Tests that want
 *     plain MCP without App-spec should boot `createGguiServer`
 *     directly — this fixture is opinionated for the host-simulator
 *     happy path.
 *   - `renderChannel: true` so the WS endpoint is mounted (the host
 *     simulator's `subscribeWith` needs it).
 *   - silent logger so test output stays readable.
 */
import { createGguiServer, type GguiServer } from '@ggui-ai/mcp-server';
import type { Server as HttpServer } from 'node:http';

export interface OssFixture {
  readonly server: GguiServer;
  readonly httpServer: HttpServer;
  /** `http://127.0.0.1:<port>` — pass into HostSimulator.url. */
  readonly url: string;
  /** `ws://127.0.0.1:<port>/ws` — useful when bypassing HostSimulator. */
  readonly wsUrl: string;
  /** Tear down. Idempotent. */
  close(): Promise<void>;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

export async function bootOssServer(
  overrides: Parameters<typeof createGguiServer>[0] = {},
): Promise<OssFixture> {
  // Two-phase boot: listen first to learn the port, THEN re-build the
  // server with mcpApps.wsUrl pointing at the real address. The OSS
  // factory needs the WS URL at construct time so bootstrap-token mint
  // emits a connectable wsUrl rather than the default `ws://localhost/ws`
  // (which fails on port 80 by default).
  //
  // We use a lightweight pre-listen pattern: start a throwaway
  // listener to grab a free port, close it, then boot the real server
  // bound to that port. Race-free for the test process.
  const probe = (await import('node:net')).createServer();
  const port: number = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('probe.address() did not return AddressInfo');
      }
      resolve(addr.port);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const url = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const server = createGguiServer({
    logger: silentLogger,
    renderChannel: true,
    mcpApps: {
      // Explicit `wsUrl` so bootstrap tokens carry a connectable URL —
      // without this, the OSS default emits `ws://localhost/ws`
      // (port 80) which fails in tests.
      wsUrl,
    },
    wsTokenSecret: 'test-host-simulator-secret-32bytes',
    ...overrides,
  });
  const httpServer = await server.listen(port, '127.0.0.1');
  return {
    server,
    httpServer,
    url,
    wsUrl,
    close: async () => {
      await server.close();
    },
  };
}
