/**
 * Hono server + route handlers for the OSS registry. Each route is a
 * thin transport adapter over a {@link registryCore} operation:
 *
 *   GET  /healthz                          → liveness
 *   GET  /search                           → searchArtifacts
 *   GET  /pkg/:scope/:name/:version        → readArtifact
 *   POST /publish                          → publishArtifact (bearer-gated)
 *   POST /author-keys                      → registerAuthorKey (bearer-gated)
 *   GET  /author-keys                      → listAuthorKeys (bearer-gated)
 *   DELETE /author-keys/:keyId             → deleteAuthorKey (bearer-gated)
 *   POST /conformance/check                → checkConformance (pre-flight gate)
 *   GET  /bundles/public/:scope/:name/:version/bundle.js        (anonymous)
 *   GET  /bundles/public/:scope/:name/:version/bundle.js.sig    (anonymous)
 *   GET  /bundles/public/:scope/:name/:version/manifest.json    (anonymous)
 *   GET  /bundles/private/:scope/:name/:version/bundle.js       (bearer-gated)
 *   GET  /bundles/private/:scope/:name/:version/bundle.js.sig   (bearer-gated)
 *   GET  /bundles/private/:scope/:name/:version/manifest.json   (bearer-gated)
 *
 * Bundle / signature / manifest serves go through {@link BundleStorage}
 * directly so the operator can plug a different storage backend
 * (memory for tests; filesystem for self-hosting) without rewriting
 * the route table.
 *
 * H1 visibility split: blob placement mirrors the manifest's
 * `visibility` (`bundles/public/…` vs `bundles/private/…`), and the
 * ROUTE decides the auth posture — the public prefix serves
 * anonymously; the private prefix requires a bearer AND authorizes the
 * caller against the artifact's publisher or the scope owner (403
 * otherwise; unknown triples answer 404). A blob is only findable
 * through the prefix it was published under, so a private artifact can
 * never be fetched via the anonymous route.
 *
 * Cache headers: public-prefix responses emit
 * `Cache-Control: public, max-age=31536000, immutable` (bundles are
 * SRI-pinned + immutable post-publish); private-prefix responses stay
 * immutable but non-shared-cacheable
 * (`Cache-Control: private, max-age=31536000, immutable`).
 *
 * CORS: permissive on public-read routes (`/search`, `/pkg/*`,
 * `/bundles/public/*`, `/conformance/check`); strict on `/publish`
 * (same-origin or no Origin header — the install CLI runs
 * server-to-server, not browser-side) AND on `/bundles/private/*`
 * (per-caller authorized content — no ACAO, no permissive preflight;
 * browser consumers of private bundles go through presigned URLs
 * rather than cross-origin credentialed fetches).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  canReadPrivateArtifact,
  checkConformance,
  createScopeOwnerResolver,
  deleteAuthorKey,
  unauthorizedErrorBody,
  listArtifactVersions,
  listAuthorKeys,
  publishArtifact,
  registerAuthorKey,
  type BlueprintProbeRunner,
  type PublishArtifactDeps,
  readArtifact,
  searchArtifacts,
  type BundleStorage,
  type ConformanceRequestPayload,
  type PublishRequestBody,
  type RegisterAuthorKeyRequestBody,
  type RegistryStorage,
  type Visibility,
} from '@ggui-ai/registry-core';
import type { BearerAuthn } from './authn/bearer.js';

const IMMUTABLE_CACHE_HEADER = 'public, max-age=31536000, immutable';
/**
 * Private-prefix responses are immutable too, but MUST NOT land in
 * shared caches — the authorization decision is per-caller.
 */
const PRIVATE_IMMUTABLE_CACHE_HEADER = 'private, max-age=31536000, immutable';

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
  /**
   * Optional TUF trust-root tuning for sigstore-cosign publish
   * verification, forwarded verbatim to the publish op. Point
   * `tufMirrorURL` + `tufRootPath` at an alternative TUF repository
   * (private sigstore deployments; hermetic tests); `tufCachePath` /
   * `tufForceCache` control cache placement + warm reuse. Unset =
   * the sigstore public-good trust root.
   */
  readonly sigstoreTuf?: PublishArtifactDeps['sigstoreTuf'];
  /**
   * Optional verified-email lookup for the publish gate's F4 identity
   * binding — see {@link PublishArtifactDeps.verifiedEmailResolver}
   * for the contract. Unset (the default here): publisher identity is
   * enforced only on scopes whose ownership row carries a
   * `sanAllowlist`; scopes without one accept any identity a valid
   * sigstore bundle proves. Wire a resolver backed by your identity
   * layer to bind default publishes to account emails.
   */
  readonly verifiedEmailResolver?: PublishArtifactDeps['verifiedEmailResolver'];
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
  const sigstoreTuf = options.sigstoreTuf;
  const verifiedEmailResolver = options.verifiedEmailResolver;

  const app = new Hono();

  // Shared bearer gate for every authed route — ONE verification call
  // shape, ONE 401 body (`unauthorizedErrorBody`, exported beside the
  // registry-core error enums so every transport of this wire contract
  // agrees).
  const verifyBearer = (c: Context) => authn.verify(c.req.header('authorization'));

  // CORS — permissive read; strict for /publish AND the private
  // bundle prefix (review finding 5). Private bundles are per-caller
  // authorized content: no cross-origin page has any business reading
  // them, and the browser consumers that need private bundle bytes go
  // through presigned URLs, not cross-origin credentialed fetches.
  // Adds ACAO headers AFTER the route runs so they overlay on the
  // route's response.
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const isCorsExcluded =
      path === '/publish' || path.startsWith('/bundles/private/');
    if (c.req.method === 'OPTIONS' && !isCorsExcluded) {
      // Preflight short-circuit for read routes. DELETE is listed for
      // the author-key management route — a browser console revokes
      // keys cross-origin ([E]).
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, authorization',
        },
      });
    }
    await next();
    if (!isCorsExcluded) {
      c.res.headers.set('Access-Control-Allow-Origin', '*');
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
        tool: q.tool,
        server: q.server,
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

    const verified = verifyBearer(c);
    if (verified === null) {
      return c.json(unauthorizedErrorBody(), 401);
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
        ...(sigstoreTuf !== undefined ? { sigstoreTuf } : {}),
        ...(verifiedEmailResolver !== undefined ? { verifiedEmailResolver } : {}),
      },
    );

    return c.json(result.body, result.status);
  });

  // ── /author-keys ─────────────────────────────────────────────────────
  // Registers a publisher Ed25519 public key under the
  // bearer-authenticated subject's identity. Shares one wire contract
  // with the hosted registry's author-keys endpoint.
  app.post('/author-keys', async (c) => {
    const verified = verifyBearer(c);
    if (verified === null) {
      return c.json(unauthorizedErrorBody(), 401);
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
      {
        publicKeyBase64: body.publicKeyBase64,
        ...(body.label !== undefined ? { label: body.label } : {}),
      },
      { storage, authn: verified, clock },
    );
    return c.json(result.body, result.status);
  });

  // ── GET /author-keys ─────────────────────────────────────────────────
  // Lists the bearer-authenticated subject's registered signing keys.
  // Bearer REQUIRED: "my keys" has no anonymous projection, so a
  // missing/invalid token is a 401 — never an empty anonymous list.
  app.get('/author-keys', async (c) => {
    const verified = verifyBearer(c);
    if (verified === null) {
      return c.json(unauthorizedErrorBody(), 401);
    }
    const result = await listAuthorKeys({ storage, authn: verified });
    return c.json(result.body, result.status);
  });

  // ── DELETE /author-keys/:keyId ───────────────────────────────────────
  // Hard-deletes the caller's `(subject, keyId)` row. Idempotent
  // (absent → 200 `deleted: false`) and subject-scoped — see the op's
  // docstring. Bearer REQUIRED, same as the list route. keyIds are
  // base64url (`derivePublicKeyId`) — URL-safe by construction, the
  // path param is the keyId verbatim.
  app.delete('/author-keys/:keyId', async (c) => {
    const verified = verifyBearer(c);
    if (verified === null) {
      return c.json(unauthorizedErrorBody(), 401);
    }
    const { keyId } = c.req.param();
    const result = await deleteAuthorKey({ keyId }, { storage, authn: verified });
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
    const result = await checkConformance(payload);
    // Domain-vs-transport split: a "non-conformant" submission is a
    // valid request that produced a `ok: false` body. Mirrors the cloud
    // conformance handler's wire shape.
    return c.json(result, 200);
  });

  // ── /bundles/public/… — anonymous, CDN-parity serving ────────────────
  app.get('/bundles/public/:scope/:name/:version/bundle.js', async (c) => {
    const { scope, name, version } = c.req.param();
    return serveBundle(c, bundleStorage, scope, name, version, 'public');
  });
  app.get('/bundles/public/:scope/:name/:version/bundle.js.sig', async (c) => {
    const { scope, name, version } = c.req.param();
    return serveSignature(c, bundleStorage, scope, name, version, 'public');
  });
  app.get('/bundles/public/:scope/:name/:version/manifest.json', async (c) => {
    const { scope, name, version } = c.req.param();
    return serveManifest(c, bundleStorage, scope, name, version, 'public');
  });

  // ── /bundles/private/… — authenticated + ownership-authorized ────────
  // Auth rule (H1): a valid bearer is required (401 — uniform, fires
  // before any storage read, so it can't distinguish triples); then
  // authorization goes through H2's shared `canReadPrivateArtifact`
  // predicate (publisher OR scope owner; owner lookup lazy + memoized
  // + fail-closed via `createScopeOwnerResolver`). Unknown triples,
  // rows that are not private (their blobs live on the public prefix),
  // AND authorization denials all answer the SAME opaque 404 — a
  // distinguishable denial is an existence oracle for private
  // artifacts. Storage faults answer the documented `server_error`
  // envelope with NO raw error text (fail closed, log server-side).
  const privateBundleGate = async (
    c: Context,
    rawScope: string,
    name: string,
    version: string,
  ): Promise<Response | null> => {
    const verified = authn.verify(c.req.header('authorization'));
    if (verified === null) {
      return c.json(
        {
          error: 'unauthorized',
          message:
            'private bundles require a valid bearer token in the Authorization header',
        },
        401,
      );
    }
    const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
    const artifactId = `${scope}/${name}`;
    let row;
    try {
      row = await storage.getArtifactVersion(artifactId, version);
    } catch (err) {
      // Fail closed with the documented envelope — the raw fault text
      // stays server-side (a wire-visible internals string is both a
      // leak and a fingerprint).
      // eslint-disable-next-line no-console -- server-side operator signal; the wire stays opaque
      console.error('registry: private bundle gate storage read failed', {
        artifactId,
        version,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(errorBody('server_error', 'internal error'), 500);
    }
    if (row === null || row.visibility !== 'private') {
      return c.json(errorBody('not_found', 'bundle not found'), 404);
    }
    // `createScopeOwnerResolver` already resolves owner-lookup faults
    // to null (deny) with its own server-side log, so no try/catch is
    // needed around the predicate.
    const authorized = await canReadPrivateArtifact(
      verified,
      row,
      createScopeOwnerResolver(storage, artifactId),
    );
    if (!authorized) {
      return c.json(errorBody('not_found', 'bundle not found'), 404);
    }
    return null;
  };

  app.get('/bundles/private/:scope/:name/:version/bundle.js', async (c) => {
    const { scope, name, version } = c.req.param();
    const denied = await privateBundleGate(c, scope, name, version);
    if (denied !== null) return denied;
    return serveBundle(c, bundleStorage, scope, name, version, 'private');
  });
  app.get('/bundles/private/:scope/:name/:version/bundle.js.sig', async (c) => {
    const { scope, name, version } = c.req.param();
    const denied = await privateBundleGate(c, scope, name, version);
    if (denied !== null) return denied;
    return serveSignature(c, bundleStorage, scope, name, version, 'private');
  });
  app.get('/bundles/private/:scope/:name/:version/manifest.json', async (c) => {
    const { scope, name, version } = c.req.param();
    const denied = await privateBundleGate(c, scope, name, version);
    if (denied !== null) return denied;
    return serveManifest(c, bundleStorage, scope, name, version, 'private');
  });

  return app;
}

/** Cache header for the given prefix — see the module docstring. */
function cacheHeaderFor(visibility: Visibility): string {
  return visibility === 'public'
    ? IMMUTABLE_CACHE_HEADER
    : PRIVATE_IMMUTABLE_CACHE_HEADER;
}

/**
 * Serve the bundle bytes. `application/javascript` MIME with the
 * visibility-appropriate immutable cache header. 404 on miss.
 */
async function serveBundle(
  c: Context,
  bundleStorage: BundleStorage,
  rawScope: string,
  name: string,
  version: string,
  visibility: Visibility,
): Promise<Response> {
  const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
  let bytes: Uint8Array | null;
  try {
    bytes = await bundleStorage.getBundle(scope, name, version, visibility);
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
      'Cache-Control': cacheHeaderFor(visibility),
    },
  });
}

async function serveSignature(
  c: Context,
  bundleStorage: BundleStorage,
  rawScope: string,
  name: string,
  version: string,
  visibility: Visibility,
): Promise<Response> {
  const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
  let sig;
  try {
    sig = await bundleStorage.getSignature(scope, name, version, visibility);
  } catch (err) {
    return c.json(errorBody('server_error', errorMessage(err)), 500);
  }
  if (sig === null) {
    return c.json(errorBody('not_found', 'signature not found'), 404);
  }
  c.header('Cache-Control', cacheHeaderFor(visibility));
  return c.json(sig, 200);
}

async function serveManifest(
  c: Context,
  bundleStorage: BundleStorage,
  rawScope: string,
  name: string,
  version: string,
  visibility: Visibility,
): Promise<Response> {
  const scope = rawScope.startsWith('@') ? rawScope : `@${rawScope}`;
  let manifest;
  try {
    manifest = await bundleStorage.getManifest(scope, name, version, visibility);
  } catch (err) {
    return c.json(errorBody('server_error', errorMessage(err)), 500);
  }
  if (manifest === null) {
    return c.json(errorBody('not_found', 'manifest not found'), 404);
  }
  c.header('Cache-Control', cacheHeaderFor(visibility));
  return c.json(manifest, 200);
}

function errorBody(error: string, message: string): { error: string; message: string } {
  return { error, message };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
