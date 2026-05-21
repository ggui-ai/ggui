/**
 * `@ggui-ai/registry-server` — self-hostable HTTP server for the ggui
 * marketplace registry.
 *
 * Wraps `@ggui-ai/registry-core` with hono + filesystem storage +
 * bearer-token auth. The hosted registry uses the same registry-core
 * ops behind a different transport (a managed gateway, DynamoDB,
 * object storage, and hosted auth).
 *
 * Two entry points:
 *
 *   - `createRegistryApp({...})`    — hono app object only (no port binding).
 *                                     Use this when embedding inside an
 *                                     existing hono / express / next.js server.
 *
 *   - `createRegistryServer({...})` — boots a `@hono/node-server` on a port.
 *                                     Returns `{ start, stop, actualPort }`.
 *                                     Use this for `npx @ggui-ai/registry-server`
 *                                     + e2e fixtures + standalone deployments.
 */
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type {
  BlueprintProbeRunner,
  BundleStorage,
  RegistryStorage,
} from '@ggui-ai/registry-core';
import type { BearerAuthn } from './authn/bearer.js';
import { createRegistryApp } from './server.js';

export { createBearerAuthn, type BearerAuthn, type CreateBearerAuthnOptions } from './authn/bearer.js';
export {
  createFilesystemBundleStorage,
  type FilesystemBundleStorageOptions,
} from './filesystem-bundle-storage.js';
export {
  createFilesystemRegistryStorage,
  type FilesystemRegistryStorageOptions,
} from './filesystem-registry-storage.js';
export { createRegistryApp, type RegistryAppOptions } from './server.js';

export interface CreateRegistryServerOptions {
  readonly storage: RegistryStorage;
  readonly bundleStorage: BundleStorage;
  readonly authn: BearerAuthn;
  /** Default: `'0.0.0.0'`. */
  readonly host?: string;
  /** Default: `9001`. Pass `0` to let the OS assign a free port. */
  readonly port?: number;
  /**
   * Public URL prefix the install CLI / iframe runtime fetches bundles
   * from. Typically `http://localhost:<port>` for local dev. Required
   * because the server cannot reliably guess its own public address
   * (operator may front it with a reverse proxy at a different host).
   * No trailing slash.
   */
  readonly bundleHost: string;
  /**
   * Hostname (no protocol) embedded into the `installCommand` field of
   * `POST /publish` responses. Example: `localhost:9001`, or
   * `registry.example.com` behind a reverse proxy.
   */
  readonly registryHostname: string;
  /** Wall-clock provider — overridable for deterministic tests. */
  readonly clock?: () => Date;
  /**
   * Optional blueprint runtime probe. Wire `@ggui-ai/blueprint-probe`'s
   * `blueprintProbeRunner` to enable the publish-time runtime gate.
   * Forwarded to `createRegistryApp`.
   *
   * Intentionally opt-in: `vm.runInContext` is NOT a security boundary
   * — sandboxed code can escape it (e.g. via
   * `require('react').useState.constructor`). Wire this only when the
   * trust boundary is the caller's process — e.g. CLI-local checks or
   * e2e fixtures, not unauthenticated public publish endpoints.
   */
  readonly blueprintProbe?: BlueprintProbeRunner;
}

export interface RegistryServerHandle {
  /** The port the server is actually bound to. Resolves after {@link start}. */
  readonly actualPort: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createRegistryServer(
  options: CreateRegistryServerOptions,
): RegistryServerHandle {
  const app = createRegistryApp({
    storage: options.storage,
    bundleStorage: options.bundleStorage,
    authn: options.authn,
    registryHostname: options.registryHostname,
    clock: options.clock,
    ...(options.blueprintProbe !== undefined
      ? { blueprintProbe: options.blueprintProbe }
      : {}),
  });

  const host = options.host ?? '0.0.0.0';
  const requestedPort = options.port ?? 9001;

  // `actualPort` is mutable until `start()` resolves with the bound
  // port — we expose a getter to keep the interface read-only.
  let actualPort = requestedPort;
  let server: ServerType | null = null;

  return {
    get actualPort(): number {
      return actualPort;
    },
    async start(): Promise<void> {
      if (server !== null) return; // idempotent
      await new Promise<void>((resolve, reject) => {
        try {
          server = serve({ fetch: app.fetch, hostname: host, port: requestedPort }, (info) => {
            actualPort = (info as AddressInfo).port;
            resolve();
          });
        } catch (err) {
          reject(err);
        }
      });
    },
    async stop(): Promise<void> {
      if (server === null) return;
      const s = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
