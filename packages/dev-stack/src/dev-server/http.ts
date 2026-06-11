/**
 * Read-only HTTP surface for `LocalUiRegistry`.
 *
 * Endpoints (v1):
 *
 *   GET  /health            → `{ ok: true, app, uiCount, issues }`
 *   GET  /uis               → `UiManifestEntry[]` (JSON)
 *   GET  /uis/:id           → `UiManifestEntry` or 404
 *   GET  /uis/:id/bundle    → compiled JS bundle, or 404
 *
 * No write verbs, no subscribe. The `UiRegistry.capabilities` probe
 * exposed on `LocalUiRegistry` already declares this publicly; the
 * endpoints are strictly GETs so consuming hosts can't accidentally
 * attempt a publish against a read-only source.
 *
 * Security posture:
 *
 *   - Binds to `127.0.0.1` by default (loopback only). A user who
 *     wants LAN access passes `host: '0.0.0.0'` and accepts the
 *     implication.
 *   - Token / CORS policy is supplied by the caller via the
 *     security-policy seam (see `./auth.ts`).
 *
 * Node's native `http` module is used directly — no framework
 * dependency. The handler is small enough (≈4 routes) that a router
 * would be overkill, and keeps the open CLI's dependency footprint
 * minimal.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { UiBundle } from '@ggui-ai/ui-registry';
import type { LocalUiRegistry } from '../local-registry/local-registry.js';
import type { GguiJsonV1 } from '@ggui-ai/project-config';
import type { DevServerSecurityPolicy } from './auth.js';
import { openEventStream } from './events.js';
import {
  emptyRuntimeSnapshot,
  type RuntimeSupervisor,
} from '../runtime-supervisor.js';
import { serveHubShell } from './hub.js';
import {
  extractSelectedId,
  serveHubPreviewBundle,
  serveHubPreviewShell,
} from './hub-preview.js';

export interface DevServerOptions {
  registry: LocalUiRegistry;
  /** Loaded `ggui.json`, used for the `/health` payload. */
  manifest: GguiJsonV1;
  /**
   * Port to bind. `0` asks the OS for a free port — the chosen port
   * is available via `DevServerHandle.port`.
   */
  port?: number;
  /**
   * Bind address. Defaults to `127.0.0.1` — loopback-only. Pass
   * `'0.0.0.0'` only if you know you want LAN exposure.
   */
  host?: string;
  /**
   * Auth + CORS policy. Optional — when omitted the server is open
   * to any reachable caller, appropriate only for tests. The CLI
   * always constructs a real policy via
   * {@link createSecurityPolicy} (see `./auth.ts`).
   */
  security?: DevServerSecurityPolicy;
  /**
   * Late-binding accessor for the runtime supervisor. The dev
   * server asks the accessor per-request so a supervisor that
   * attaches AFTER `startDevServer` resolves is still visible at
   * `/runtime/*`. Returning `null` yields a consistent
   * `{ present: false }` payload for the "no runtime" case.
   */
  getRuntimeSupervisor?: () => RuntimeSupervisor | null;
}

export interface DevServerHandle {
  /** Host the server is actually listening on. */
  host: string;
  /** Port the server is actually listening on (resolved if opts.port was 0). */
  port: number;
  /** Graceful shutdown. Resolves after all active connections close. */
  close(): Promise<void>;
  /** Raw server, in case callers need direct access for tests. */
  raw: Server;
}

const UI_ROUTE = /^\/uis(?:\/([^/]+)(?:\/(bundle))?)?\/?$/;
const RUNTIME_ROUTE = /^\/runtime(?:\/(status|events))?\/?$/;

/**
 * Start the read-only dev server. Resolves after `listen` completes
 * so callers can safely fire requests at the returned `port`.
 */
export async function startDevServer(
  options: DevServerOptions,
): Promise<DevServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 0;

  const server = createServer((req, res) => {
    void handleRequest(req, res, options).catch((err: unknown) => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'internal', message: errorMessage(err) });
      } else {
        res.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error(`dev server bound to unexpected address ${String(address)}`);
  }

  return {
    host: address.address,
    port: address.port,
    raw: server,
    async close() {
      // Shut down the registry watcher FIRST so open SSE streams
      // stop receiving events; otherwise write attempts after
      // `server.close()` land on half-closed sockets.
      await options.registry.close();
      // Force-destroy open sockets so SSE clients don't hold the
      // close promise open for their full keep-alive window.
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: DevServerOptions,
): Promise<void> {
  if (options.security) {
    const result = options.security.apply(req, res);
    if (result.outcome === 'handled') return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { error: 'method-not-allowed' });
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path === '/events' || path === '/events/') {
    // SSE stream — lifecycle is owned by the stream handler; it
    // returns after writing the preamble and keeps running until
    // the client disconnects.
    openEventStream(req, res, options.registry);
    return;
  }

  if (path === '/hub' || path === '/hub/') {
    // Hub shell is served unauthenticated (see `auth.ts` /
    // `PUBLIC_PATHS`). The same-origin browser tab that opens the
    // page still gets bearer-gated XHR responses — the shell
    // embeds the token so its JS carries it automatically.
    serveHubShell(req, res, {
      token: options.security?.token ?? null,
      manifest: options.manifest,
    });
    return;
  }

  if (path === '/hub/preview.js') {
    // Public JS bundle for the iframe's module script. See
    // `hub-preview.ts` for the rationale (browsers don't attach
    // Authorization on element-triggered script loads).
    await serveHubPreviewBundle(req, res);
    return;
  }

  if (path === '/hub/preview' || path === '/hub/preview/') {
    // Preview iframe shell. Public for the same reason `/hub` is
    // public — the browser loads it before any XHR fires. The
    // iframe reads `?ui=<id>` from its own URL; the shell sanitises
    // the value defensively before echoing it back.
    const selectedId = extractSelectedId(url.search.slice(1));
    serveHubPreviewShell(req, res, {
      token: options.security?.token ?? null,
      selectedId,
    });
    return;
  }

  if (path === '/health' || path === '/health/') {
    const list = await options.registry.list();
    const issues = options.registry.getIssues();
    writeJson(res, 200, {
      ok: true,
      app: options.manifest.app,
      protocol: options.manifest.protocol,
      uiCount: list.length,
      issueCount: issues.length,
    });
    return;
  }

  const runtimeMatch = RUNTIME_ROUTE.exec(path);
  if (runtimeMatch) {
    const [, kind] = runtimeMatch;
    const supervisor = options.getRuntimeSupervisor?.() ?? null;

    if (!supervisor) {
      // Always return a consistent "absent" payload rather than
      // 404 — hosts that poll `/runtime/status` don't need to
      // branch on HTTP status for the no-runtime case.
      writeJson(res, 200, emptyRuntimeSnapshot());
      return;
    }

    const snapshot = supervisor.snapshot();
    if (!kind || kind === 'status') {
      // Status endpoint returns everything EXCEPT the buffered
      // events, so clients that only need lifecycle state don't
      // pay the payload cost.
      const { recentEvents: _omit, ...rest } = snapshot;
      void _omit;
      writeJson(res, 200, rest);
      return;
    }
    if (kind === 'events') {
      writeJson(res, 200, {
        present: snapshot.present,
        name: snapshot.name,
        runId: snapshot.runId,
        status: snapshot.status,
        lastEventAt: snapshot.lastEventAt,
        events: snapshot.recentEvents,
      });
      return;
    }
  }

  const match = UI_ROUTE.exec(path);
  if (match) {
    const [, rawId, subresource] = match;

    if (!rawId) {
      const list = await options.registry.list();
      writeJson(res, 200, list);
      return;
    }

    const id = decodeURIComponent(rawId);
    const entry = await options.registry.get(id);
    if (!entry) {
      writeJson(res, 404, { error: 'not-found', id });
      return;
    }

    if (!subresource) {
      writeJson(res, 200, entry);
      return;
    }

    if (subresource === 'bundle') {
      const result = await options.registry.fetchBundle(id);
      switch (result.kind) {
        case 'ok':
          writeBundle(res, result.bundle);
          return;
        case 'not-found':
          writeJson(res, 404, { error: 'not-found', id });
          return;
        case 'missing-entry':
          // 404 still — the contract is "no bundle," consumers
          // collapse this to a "no preview available" state. The body gives
          // the developer the exact list of paths we searched so they
          // know what to add (a `ggui.ui.tsx` beside the manifest, or
          // an `entryPoint` field in `ggui.ui.json`).
          writeJson(res, 404, {
            error: 'missing-entry',
            id,
            message:
              'No compiled bundle AND no TSX entry could be resolved. Declare `entryPoint` in ggui.ui.json, ' +
              'or colocate a ggui.ui.tsx / index.tsx / component.tsx beside the manifest.',
            tried: result.tried,
          });
          return;
        case 'compile-failed':
          // 422 Unprocessable Entity — the server understood the
          // request but couldn't produce output because the source
          // fails to compile. Body carries structured esbuild errors
          // so a consuming UI can render the first error with its
          // file / line / column / highlighted line.
          writeJson(res, 422, {
            error: 'compile-failed',
            id,
            entry: result.entry,
            errors: result.errors,
            warnings: result.warnings,
          });
          return;
      }
    }
  }

  writeJson(res, 404, { error: 'not-found', path });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

function writeBundle(res: ServerResponse, bundle: UiBundle): void {
  // Streams are valid per the contract, but the LocalUiRegistry
  // always produces string bundles today; accept both defensively so
  // future cloud-registry wrappers drop in without a change here.
  if (typeof bundle.code === 'string') {
    const buffer = Buffer.from(bundle.code, 'utf-8');
    res.writeHead(200, {
      'content-type': bundle.contentType,
      'content-length': buffer.byteLength.toString(),
    });
    res.end(buffer);
    return;
  }

  res.writeHead(200, { 'content-type': bundle.contentType });
  const reader = bundle.code.getReader();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          res.write(typeof value === 'string' ? value : Buffer.from(value));
        }
      }
    } finally {
      res.end();
    }
  })();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
