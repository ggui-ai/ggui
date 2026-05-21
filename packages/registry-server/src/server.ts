/**
 * Hono server + route handlers for the OSS registry. Each route is a
 * thin transport adapter over a {@link registryCore} operation:
 *
 *   GET  /healthz                          → liveness
 *   GET  /search                           → searchArtifacts
 *   GET  /pkg/:scope/:name/:version        → readArtifact
 *   POST /publish                          → publishArtifact (bearer-gated)
 *   POST /conformance/check                → checkConformance (pre-flight gate)
 *   GET  /bundles/:scope/:name/:version/bundle.js
 *   GET  /bundles/:scope/:name/:version/bundle.js.sig
 *   GET  /bundles/:scope/:name/:version/manifest.json
 *
 * Bundle / signature / manifest serves go through {@link BundleStorage}
 * directly so the operator can plug a different storage backend
 * (memory for tests; filesystem for self-hosting) without rewriting
 * the route table. The server always emits
 * `Cache-Control: public, max-age=31536000, immutable` on these
 * routes — bundles are SRI-pinned + immutable post-publish.
 *
 * CORS: permissive on public-read routes (`/search`, `/pkg/*`,
 * `/bundles/*`, `/conformance/check`); strict on `/publish` (same-origin
 * or no Origin header — the install CLI runs server-to-server, not
 * browser-side).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  checkConformance,
  listArtifactVersions,
  publishArtifact,
  registerAuthorKey,
  type BlueprintProbeRunner,
  readArtifact,
  searchArtifacts,
  type BundleStorage,
  type ConformanceRequestPayload,
  type PublishRequestBody,
  type RegisterAuthorKeyRequestBody,
  type RegistryStorage,
} from '@ggui-ai/registry-core';
import type { BearerAuthn } from './authn/bearer.js';

const IMMUTABLE_CACHE_HEADER = 'public, max-age=31536000, immutable';

export interface RegistryAppOptions {
  readonly storage: RegistryStorage;
  readonly bundleStorage: BundleStorage;
  readonly authn: BearerAuthn;
  /** Hostname (no protocol) for the publish-success `installCommand` field. */
  readonly registryHostname: string;
  /** Wall-clock provider — overridable for deterministic tests. */
  readonly clock?: () => Date;
  /**
   * Optional blueprint runtime probe. Wire `@ggui-ai/blueprint-probe`'s
   * `blueprintProbeRunner` here to enable the publish-time runtime
   * gate (compile + sandboxed React render). Leaving it unset runs
   * only the static gates from `checkConformance`.
   */
  readonly blueprintProbe?: BlueprintProbeRunner;
}

/**
 * Build the hono app. Does NOT bind a port — callers (the CLI, the
 * `createRegistryServer` factory, programmatic embeds) decide how to
 * serve it. Returned as `Hono<{}>` so the app object can be passed to
 * `@hono/node-server`'s `serve()` or any hono-compatible runtime.
 */
export function createRegistryApp(options: RegistryAppOptions): Hono {
  const { storage, bundleStorage, authn, registryHostname } = options;
  const clock = options.clock ?? (() => new Date());
  const blueprintProbe = options.blueprintProbe;

  const app = new Hono();

  // CORS — permissive read; strict for /publish. Adds ACAO headers
  // AFTER the route runs so they overlay on the route's response.
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const isPublishRoute = path === '/publish';
    if (c.req.method === 'OPTIONS' && !isPublishRoute) {
      // Preflight short-circuit for read routes.
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, authorization',
        },
      });
    }
    await next();
    if (!isPublishRoute) {
      c.res.headers.set('Access-Control-Allow-Origin', '*');
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      c.res.headers.set('Access-Control-Allow-Headers', 'content-type, authorization');
    }
  });

  // ── /healthz ─────────────────────────────────────────────────────────
  app.get('/healthz', (c) => c.json({ ok: true }));

  // ── /search ──────────────────────────────────────────────────────────
  app.get('/search', async (c) => {
    const q = c.req.query();
    const result = await searchArtifacts(
      {
        q: q.q,
        kind: q.kind,
        hook: q.hook,
        tag: q.tag,
        author: q.author,
        limit: q.limit,
        cursor: q.cursor,
        sort: q.sort,
      },
      { storage },
    );
    if (!result.ok) {
      return c.json(result.body, result.status);
    }
    return c.json(result.body, 200);
  });

  // ── /pkg/:scope/:name ────────────────────────────────────────────────
  // List-versions endpoint. Returns the version timeline for an
  // artifact. MUST be registered BEFORE `/pkg/:scope/:name/:version`
  // so Hono's matcher doesn't shadow it (Hono routes are checked in
  // registration order; a more-specific later route would still win
  // since both arms have unique segment counts, but registering the
  // broader pattern first keeps the wire contract obvious from the
  // source order).
  app.get('/pkg/:scope/:name', async (c) => {
    const { scope: rawScope, name } = c.req.param();
    const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
    const artifactId = `${scope}/${name}`;

    const authHeader = c.req.header('authorization');
    const verified = authn.verify(authHeader);

    const result = await listArtifactVersions(
      { artifactId },
      {
        storage,
        authn: verified ?? undefined,
      },
    );

    return c.json(result.body, result.status);
  });

  // ── /pkg/:scope/:name/:version ───────────────────────────────────────
  app.get('/pkg/:scope/:name/:version', async (c) => {
    const { scope: rawScope, name, version } = c.req.param();
    // The CLI strips the leading `@` from the scope when composing the
    // URL — mirrors the cloud API Gateway path-param convention. We
    // re-prepend the `@` here so the registry-core op gets the
    // canonical `@scope/name` form. If the client sends an already-
    // prefixed scope (curl test, dev tooling), normalize to single `@`.
    const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
    const artifactId = `${scope}/${name}`;

    const authHeader = c.req.header('authorization');
    const verified = authn.verify(authHeader);

    const result = await readArtifact(
      { artifactId, version },
      {
        storage,
        authn: verified ?? undefined,
      },
    );

    if (result.ok) {
      return c.json(result.body, 200);
    }
    if (result.status === 410) {
      return c.json(result.body, 410);
    }
    return c.json(result.body, result.status);
  });

  // ── /publish ─────────────────────────────────────────────────────────
  app.post('/publish', async (c) => {
    // Strict CORS — no Access-Control-Allow-Origin emitted; reject
    // cross-origin Origin headers up front (browsers MUST send Origin
    // on a CORS preflight). Server-to-server clients (the CLI) won't
    // send Origin at all, so absence is allowed.
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== '') {
      // Defensive: don't echo. Browsers will reject without the
      // ACAO header, which is the protection we want.
    }

    const authHeader = c.req.header('authorization');
    const verified = authn.verify(authHeader);
    if (verified === null) {
      return c.json(
        {
          error: 'unauthorized',
          message: 'publish requires a valid bearer token in the Authorization header',
        },
        401,
      );
    }

    let body: PublishRequestBody;
    try {
      body = (await c.req.json()) as PublishRequestBody;
    } catch {
      return c.json(
        { error: 'manifest_invalid', message: 'request body is not valid JSON' },
        400,
      );
    }

    const result = await publishArtifact(
      {
        manifest: body.manifest,
        bundle: body.bundle,
        bundleSha384: body.bundleSha384,
        signature: body.signature,
      },
      {
        storage,
        bundleStorage,
        authn: verified,
        clock,
        registryHostname,
        ...(blueprintProbe !== undefined ? { blueprintProbe } : {}),
      },
    );

    return c.json(result.body, result.status);
  });

  // ── /author-keys ─────────────────────────────────────────────────────
  // Registers a publisher Ed25519 public key under the
  // bearer-authenticated subject's identity. Shares one wire contract
  // with the hosted registry's author-keys endpoint.
  app.post('/author-keys', async (c) => {
    const authHeader = c.req.header('authorization');
    const verified = authn.verify(authHeader);
    if (verified === null) {
      return c.json(
        {
          error: 'unauthorized',
          message:
            'author-keys requires a valid bearer token in the Authorization header',
        },
        401,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: 'invalid_request', message: 'request body is not valid JSON' },
        400,
      );
    }

    // Guard against JSON `null` + JSON primitives — Hono's
    // `c.req.json()` succeeds on those (returns the value verbatim),
    // and the next line would throw TypeError trying to read
    // `.publicKeyBase64` off them. The hosted registry's author-keys
    // endpoint applies the same guard so the two transports agree on
    // the 400 wire shape.
    if (rawBody === null || typeof rawBody !== 'object') {
      return c.json(
        { error: 'invalid_request', message: 'request body must be a JSON object' },
        400,
      );
    }
    const body = rawBody as RegisterAuthorKeyRequestBody;

    if (typeof body.publicKeyBase64 !== 'string') {
      return c.json(
        {
          error: 'invalid_request',
          message: '`publicKeyBase64` must be a string',
        },
        400,
      );
    }

    const result = await registerAuthorKey(
      { publicKeyBase64: body.publicKeyBase64 },
      { storage, authn: verified },
    );
    return c.json(result.body, result.status);
  });

  // ── /conformance/check ───────────────────────────────────────────────
  app.post('/conformance/check', async (c) => {
    let payload: ConformanceRequestPayload;
    try {
      payload = (await c.req.json()) as ConformanceRequestPayload;
    } catch {
      return c.json(
        { ok: false, errors: [{ code: 'manifest_invalid', message: 'request body is not valid JSON' }] },
        400,
      );
    }
    const result = checkConformance(payload);
    // Domain-vs-transport split: a "non-conformant" submission is a
    // valid request that produced a `ok: false` body. Mirrors the cloud
    // conformance handler's wire shape.
    return c.json(result, 200);
  });

  // ── /bundles/:scope/:name/:version/bundle.js ─────────────────────────
  app.get('/bundles/:scope/:name/:version/bundle.js', async (c) => {
    const { scope, name, version } = c.req.param();
    return serveBundle(c, bundleStorage, scope, name, version);
  });

  // ── /bundles/:scope/:name/:version/bundle.js.sig ─────────────────────
  app.get('/bundles/:scope/:name/:version/bundle.js.sig', async (c) => {
    const { scope, name, version } = c.req.param();
    return serveSignature(c, bundleStorage, scope, name, version);
  });

  // ── /bundles/:scope/:name/:version/manifest.json ─────────────────────
  app.get('/bundles/:scope/:name/:version/manifest.json', async (c) => {
    const { scope, name, version } = c.req.param();
    return serveManifest(c, bundleStorage, scope, name, version);
  });

  return app;
}

/**
 * Serve the bundle bytes. `application/javascript` MIME with the
 * immutable cache header. 404 on miss.
 */
async function serveBundle(
  c: Context,
  bundleStorage: BundleStorage,
  rawScope: string,
  name: string,
  version: string,
): Promise<Response> {
  const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
  let bytes: Uint8Array | null;
  try {
    bytes = await bundleStorage.getBundle(scope, name, version);
  } catch (err) {
    return c.json(errorBody('server_error', errorMessage(err)), 500);
  }
  if (bytes === null) {
    return c.json(errorBody('not_found', 'bundle not found'), 404);
  }
  // Re-wrap the Uint8Array so its backing buffer is a plain ArrayBuffer
  // (hono's `c.body` typing rejects `Uint8Array<ArrayBufferLike>` because
  // the SharedArrayBuffer branch is incompatible with the Web Response
  // body constructor). The copy is a single contiguous allocation —
  // bundles are bounded by `MAX_BUNDLE_BYTES` (5 MiB), so this is cheap.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': IMMUTABLE_CACHE_HEADER,
    },
  });
}

async function serveSignature(
  c: Context,
  bundleStorage: BundleStorage,
  rawScope: string,
  name: string,
  version: string,
): Promise<Response> {
  const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
  let sig;
  try {
    sig = await bundleStorage.getSignature(scope, name, version);
  } catch (err) {
    return c.json(errorBody('server_error', errorMessage(err)), 500);
  }
  if (sig === null) {
    return c.json(errorBody('not_found', 'signature not found'), 404);
  }
  c.header('Cache-Control', IMMUTABLE_CACHE_HEADER);
  return c.json(sig, 200);
}

async function serveManifest(
  c: Context,
  bundleStorage: BundleStorage,
  rawScope: string,
  name: string,
  version: string,
): Promise<Response> {
  const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
  let manifest;
  try {
    manifest = await bundleStorage.getManifest(scope, name, version);
  } catch (err) {
    return c.json(errorBody('server_error', errorMessage(err)), 500);
  }
  if (manifest === null) {
    return c.json(errorBody('not_found', 'manifest not found'), 404);
  }
  c.header('Cache-Control', IMMUTABLE_CACHE_HEADER);
  return c.json(manifest, 200);
}

function errorBody(error: string, message: string): { error: string; message: string } {
  return { error, message };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
