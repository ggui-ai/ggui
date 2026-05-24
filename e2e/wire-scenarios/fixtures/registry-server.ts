/**
 * Boot a `@ggui-ai/registry-server` for a Slice 4.5 lifecycle test.
 *
 * Reserves a free port via `node:net`, instantiates the server with
 * in-memory storage + bearer authn, and returns a handle plus the
 * environment overrides a CLI subprocess needs to talk to it.
 *
 * The shared test token is intentionally fixed (`test-token`) — the
 * fixture configures the bearer authn to accept exactly this string.
 * Per-test isolation comes from the per-test memory storage instance,
 * not the token.
 */
import { createServer as createNetServer } from 'node:net';
import {
  inMemoryRegistryStorage,
  inMemoryBundleStorage,
  type RegistryStorage,
  type BundleStorage,
} from '@ggui-ai/registry-core';
import { createRegistryServer, createBearerAuthn } from '@ggui-ai/registry-server';

export interface RegistryServerHandle {
  readonly url: string;
  readonly port: number;
  readonly storage: RegistryStorage;
  readonly bundleStorage: BundleStorage;
  readonly env: Record<string, string>;
  stop(): Promise<void>;
}

export const TEST_REGISTRY_TOKEN = 'test-token';
export const TEST_REGISTRY_SUBJECT = 'test-user';

/**
 * Allocate a free TCP port. Opens a listener with `port: 0`, reads
 * back the OS-assigned port, then closes the listener. Tiny race
 * window between close + reuse, fine for test orchestration.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close();
        reject(new Error('failed to read assigned port'));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

export async function bootRegistryServer(): Promise<RegistryServerHandle> {
  const port = await findFreePort();
  const host = '127.0.0.1';
  const bundleHost = `http://${host}:${port}`;
  const registryHostname = `${host}:${port}`;

  const storage = inMemoryRegistryStorage();
  const bundleStorage = inMemoryBundleStorage({ bundleHost });
  const authn = createBearerAuthn({
    token: TEST_REGISTRY_TOKEN,
    subject: TEST_REGISTRY_SUBJECT,
  });

  const handle = createRegistryServer({
    storage,
    bundleStorage,
    authn,
    host,
    port,
    bundleHost,
    registryHostname,
  });
  await handle.start();

  const url = `http://${host}:${handle.actualPort}`;

  return {
    url,
    port: handle.actualPort,
    storage,
    bundleStorage,
    env: {
      GGUI_REGISTRY: url,
      GGUI_REGISTRY_TOKEN: TEST_REGISTRY_TOKEN,
    },
    async stop() {
      await handle.stop();
    },
  };
}
