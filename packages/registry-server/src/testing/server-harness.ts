/**
 * Shared in-process server harness for the registry-server integration
 * suites ([E] review dedup). Boots a real `createRegistryServer` on
 * `port: 0` with memory storage + a static bearer token, so suites
 * exercise the full `@hono/node-server` transport with wire-level
 * `fetch`.
 *
 * Test-only module: excluded from the package build
 * (`tsconfig.build.json` excludes `src/testing/**`) and never exported
 * from the package entry.
 */
import {
  inMemoryBundleStorage,
  inMemoryRegistryStorage,
  type RegistryStorage,
} from '@ggui-ai/registry-core';
import { createBearerAuthn } from '../authn/bearer.js';
import { createRegistryServer, type RegistryServerHandle } from '../index.js';

export const HARNESS_TOKEN = 'harness-test-token';
export const HARNESS_SUBJECT = 'harness-subject-1';

export interface ServerHarness {
  readonly handle: RegistryServerHandle;
  readonly storage: RegistryStorage;
  readonly baseUrl: string;
  readonly authHeader: string;
}

export interface BootServerHarnessOptions {
  /** Deterministic wall clock forwarded to the server (createdAt stamps). */
  readonly clock?: () => Date;
  /** Override the verified subject issued for the harness token. */
  readonly subject?: string;
}

export async function bootServerHarness(
  options: BootServerHarnessOptions = {},
): Promise<ServerHarness> {
  const storage = inMemoryRegistryStorage();
  const handle = createRegistryServer({
    storage,
    bundleStorage: inMemoryBundleStorage({
      bundleHost: 'http://placeholder.invalid',
    }),
    authn: createBearerAuthn({
      token: HARNESS_TOKEN,
      subject: options.subject ?? HARNESS_SUBJECT,
    }),
    host: '127.0.0.1',
    port: 0,
    bundleHost: 'http://placeholder.invalid',
    registryHostname: 'localhost:9001',
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  await handle.start();
  return {
    handle,
    storage,
    baseUrl: `http://127.0.0.1:${handle.actualPort}`,
    authHeader: `Bearer ${HARNESS_TOKEN}`,
  };
}
