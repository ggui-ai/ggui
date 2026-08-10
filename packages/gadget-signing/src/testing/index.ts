/**
 * Hermetic sigstore test infrastructure for `@ggui-ai/gadget-signing`
 * consumers.
 *
 * `startSigstoreMockStack()` boots in-process mock Fulcio + Rekor HTTP
 * endpoints (nock interceptors over `@sigstore/mock`'s CA / CTLog /
 * TLog primitives) **plus** a mock TUF repository (via
 * `@tufjs/repo-mock`) that serves a `trusted_root.json` built from the
 * SAME key material the mock services sign with. The result: the real
 * `signBundleSigstore` and `verifyBundleSigstore` code paths execute
 * end-to-end — real ephemeral key generation, real cert issuance, real
 * transparency-log entries, real bundle serialization, real TUF
 * trust-root resolution, real cryptographic verification — with only
 * the network endpoints and the root of trust substituted, all through
 * the upstream `sigstore` package's public option surface
 * (`fulcioURL` / `rekorURL` on sign; `tufMirrorURL` / `tufRootPath` /
 * `tufCachePath` on verify). Nothing in the sign/verify pipeline is
 * stubbed.
 *
 * Subpath export — consumers
 * `import { startSigstoreMockStack } from '@ggui-ai/gadget-signing/testing'`.
 * Requires `@sigstore/mock`, `@tufjs/repo-mock`, `nock`, and
 * `@sigstore/protobuf-specs` at test-runtime (declared as optional
 * peerDeps; add them to devDependencies alongside this package).
 * `@tufjs/repo-mock` is pinned to exactly 4.0.1 on purpose: 4.0.2
 * moves its nock dependency to v14, which would load a second,
 * differently-patched `http` interceptor next to `@sigstore/mock`'s
 * nock v13 in the same process. At 4.0.1 both resolve one shared nock.
 *
 * Known mock-fidelity limits (upstream `@sigstore/mock` behavior —
 * document divergence from the public-good instance, don't paper over
 * it):
 *
 *   - The mock CA writes the certificate SAN as a **URI** GeneralName
 *     regardless of the subject's shape, so email-based identity
 *     policies (`certificateIdentityEmail`) can never match a
 *     mock-issued cert. Use URI-shaped subjects in identity-policy
 *     tests; the email routing itself is covered by the
 *     option-threading seam tests.
 *   - The mock Fulcio decodes (but does not cryptographically verify)
 *     the OIDC token, so {@link SigstoreMockStack.identityToken}
 *     mints unsigned JWT-shaped tokens.
 *
 * Interceptors are process-global (nock patches `http`), so run ONE
 * stack per suite and call {@link SigstoreMockStack.teardown} in
 * `afterAll`. While a stack is live the stack is HERMETIC: real
 * network egress over `http.ClientRequest` is disabled (loopback
 * excepted), so a request to any unmocked host fails fast and
 * deterministically instead of silently escaping to live DNS — a
 * `rekor: false` stack answers in milliseconds with nock's
 * disallowed-net-connect error rather than waiting on a real
 * NXDOMAIN. Undici-based `fetch` traffic is NOT intercepted (nor
 * blocked) — only the `http.ClientRequest` path the sigstore/TUF
 * clients use — so an in-process HTTP server under test keeps
 * working alongside a live stack. `teardown()` restores real network
 * access.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import {
  fulcioHandler,
  initializeCA,
  initializeCTLog,
  initializeTLog,
  rekorHandler,
} from '@sigstore/mock';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { createRequire } from 'node:module';
import type { Target } from '@tufjs/repo-mock';
import nock from 'nock';

// `@tufjs/repo-mock` ships CJS with a transpiled `exports.default`.
// Under native Node ESM a default-import binds the whole `exports`
// object (Node does not unwrap transpiled `.default`), so
// `mocktuf(...)` throws `TypeError: mocktuf is not a function` in the
// shipped artifact even though vitest's interop keeps in-repo tests
// green. `createRequire` reads the CJS shape identically in every
// runtime — pinned by `dist-esm-interop.integration.test.ts`, which
// imports the BUILT artifact under plain `node`.
const cjsRequire = createRequire(import.meta.url);
const repoMock: typeof import('@tufjs/repo-mock') = cjsRequire('@tufjs/repo-mock');
const mocktuf = repoMock.default;

type CA = Awaited<ReturnType<typeof initializeCA>>;
type CTLog = Awaited<ReturnType<typeof initializeCTLog>>;
type TLog = Awaited<ReturnType<typeof initializeTLog>>;
type MockServiceHandler = ReturnType<typeof fulcioHandler>;

/** Options for {@link startSigstoreMockStack}. */
export interface SigstoreMockStackOptions {
  /**
   * Mount the Fulcio signing-cert endpoint. Default `true`. Pass
   * `false` to exercise CA-unreachable signing failure paths.
   */
  readonly fulcio?: boolean;
  /**
   * Mount the Rekor create-entry endpoint. Default `true`. Pass
   * `false` to exercise transparency-log failure paths.
   */
  readonly rekor?: boolean;
}

/** Claims for {@link SigstoreMockStack.identityToken}. */
export interface MockIdentityClaims {
  /**
   * OIDC subject — becomes the issued certificate's SAN (as a URI
   * GeneralName; see the module docstring's mock-fidelity note).
   */
  readonly sub?: string;
  /** OIDC issuer claim — lands in the cert's issuer extension. */
  readonly iss?: string;
  /** Additional claims (email, GitHub Actions workflow claims, …). */
  readonly [claim: string]: unknown;
}

/** Handle returned by {@link startSigstoreMockStack}. */
export interface SigstoreMockStack {
  /** Base URL of the mock Fulcio instance. */
  readonly fulcioURL: string;
  /** Base URL of the mock Rekor instance. */
  readonly rekorURL: string;
  /**
   * Endpoint overrides for `signBundleSigstore` — spread into its
   * `endpoints` input.
   */
  readonly signEndpoints: {
    readonly fulcioURL: string;
    readonly rekorURL: string;
  };
  /**
   * TUF trust-root overrides for `verifyBundleSigstore` — spread into
   * its input (or a registry publish op's `sigstoreTuf` deps slot) so
   * verification resolves the MOCK trust root instead of the
   * public-good one.
   *
   * Includes `tufForceCache: true`, and load-bearingly so: the mock
   * TUF mirror's nock interceptors are single-use, so exactly ONE
   * remote metadata refresh succeeds per stack (discovered on this
   * fixture's first multi-verify run — the second refresh died with
   * `error refreshing TUF metadata`). The first verify populates the
   * cache over the mock network; every later verify reuses it — which
   * is also precisely the warm-start path serverless verifiers run in
   * production, so the cache-reuse semantics get real coverage for
   * free.
   */
  readonly tuf: {
    readonly tufMirrorURL: string;
    readonly tufRootPath: string;
    readonly tufCachePath: string;
    readonly tufForceCache: true;
  };
  /**
   * Subject the zero-argument {@link identityToken} carries — handy
   * for identity-policy assertions.
   */
  readonly defaultSubject: string;
  /** Issuer the zero-argument {@link identityToken} carries. */
  readonly defaultIssuer: string;
  /**
   * Mint an unsigned JWT-shaped OIDC token the mock Fulcio accepts.
   * The mock decodes claims without verifying a signature.
   */
  identityToken(claims?: MockIdentityClaims): string;
  /**
   * Remove ALL nock interceptors registered in this process (including
   * other live stacks — one stack per suite), restore real network
   * access, and delete the TUF repo's cache directory.
   */
  teardown(): void;
}

/**
 * Default SAN subject for minted identity tokens. URI-shaped on
 * purpose — the mock CA writes URI SANs (module docstring).
 */
const DEFAULT_SUBJECT = 'https://gadgets.ggui.test/e2e-signer';
/** Mirrors the mock Fulcio's default issuer claim. */
const DEFAULT_ISSUER = 'https://fake.oidcissuer.com';

/** Per-process counter so parallel suites get distinct mock hosts. */
let stackCounter = 0;

/**
 * Boot a full in-process sigstore mock stack: Fulcio + Rekor
 * interceptors plus a TUF repository serving a trusted root built from
 * the same keys. See the module docstring for the trust wiring.
 */
export async function startSigstoreMockStack(
  options: SigstoreMockStackOptions = {},
): Promise<SigstoreMockStack> {
  const id = (stackCounter += 1);
  const fulcioURL = `https://fulcio.mock-${id}.ggui.test`;
  const rekorURL = `https://rekor.mock-${id}.ggui.test`;
  const tufMirrorURL = `https://tuf.mock-${id}.ggui.test`;

  // One P-256 keypair roots the whole stack (CA + CTLog + TLog) —
  // mirrors `@sigstore/mock`'s own top-level `mockFulcio` /
  // `mockRekor` composition, which shares a keypair between the CA
  // and its CTLog.
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const ctlog = await initializeCTLog(keyPair);
  const ca = await initializeCA(keyPair, ctlog);
  const tlog = await initializeTLog(rekorURL, keyPair);

  // Hermetic: while the stack is live, requests to any host without a
  // registered interceptor fail fast with nock's NetConnectNotAllowed
  // error instead of escaping to real DNS/network (empirically: an
  // unmocked `.test` host cost ~3s of live NXDOMAIN lookups per
  // attempt before this). Loopback stays open for in-process HTTP
  // servers under test.
  nock.disableNetConnect();
  nock.enableNetConnect(
    (host) => host.startsWith('127.0.0.1') || host.startsWith('localhost'),
  );

  if (options.fulcio !== false) {
    mount(fulcioURL, fulcioHandler(ca, { strict: true }));
  }
  if (options.rekor !== false) {
    mount(rekorURL, rekorHandler(tlog, { strict: true }));
  }

  // Trust material for verification — the SAME roots the mock services
  // sign with, projected onto the `trusted_root.json` shape the TUF
  // client resolves. Built in the protobuf-specs JSON encoding (base64
  // bytes, enum names, ISO timestamps) and round-tripped through the
  // `TrustedRoot` codec so a field drift fails loudly here rather than
  // deep inside the verifier. (The installed protobuf-specs build
  // exposes only `fromJSON`/`toJSON` — no `fromPartial` — discovered
  // on this fixture's first run.)
  //
  // Validity windows are backdated one minute so cert-chain checks sit
  // comfortably inside the window even under clock skew between this
  // init and the moment a test signs.
  const validityStart = new Date(Date.now() - 60_000).toISOString();
  const trustedRootJSON = JSON.stringify(
    TrustedRoot.toJSON(
      TrustedRoot.fromJSON({
        mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
        certificateAuthorities: [
          {
            subject: { commonName: 'sigstore', organization: 'sigstore.mock' },
            uri: fulcioURL,
            certChain: {
              certificates: [{ rawBytes: toBase64(ca.rootCertificate) }],
            },
            validFor: { start: validityStart },
          },
        ],
        tlogs: [
          {
            baseUrl: rekorURL,
            logId: {
              keyId: createHash('sha256').update(tlog.publicKey).digest('base64'),
            },
            hashAlgorithm: 'SHA2_256',
            publicKey: {
              rawBytes: tlog.publicKey.toString('base64'),
              keyDetails: 'PKIX_ECDSA_P256_SHA_256',
              validFor: { start: validityStart },
            },
          },
        ],
        ctlogs: [
          {
            baseUrl: `${fulcioURL}/ctlog`,
            logId: { keyId: toBase64(ctlog.logID) },
            hashAlgorithm: 'SHA2_256',
            publicKey: {
              rawBytes: ctlog.publicKey.toString('base64'),
              keyDetails: 'PKIX_ECDSA_P256_SHA_256',
              validFor: { start: validityStart },
            },
          },
        ],
        timestampAuthorities: [],
      }),
    ),
  );

  const target: Target = {
    name: 'trusted_root.json',
    content: Buffer.from(trustedRootJSON),
  };
  // `metadataPathPrefix: ''` matches `@sigstore/tuf`'s mirror layout
  // (metadata at the mirror root, targets under /targets).
  const tufRepo = mocktuf(target, { baseURL: tufMirrorURL, metadataPathPrefix: '' });

  return {
    fulcioURL,
    rekorURL,
    signEndpoints: { fulcioURL, rekorURL },
    tuf: {
      tufMirrorURL: tufRepo.baseURL,
      tufCachePath: tufRepo.cachePath,
      tufRootPath: join(tufRepo.cachePath, 'root.json'),
      tufForceCache: true,
    },
    defaultSubject: DEFAULT_SUBJECT,
    defaultIssuer: DEFAULT_ISSUER,
    identityToken(claims: MockIdentityClaims = {}): string {
      return mintUnsignedJwt({
        sub: DEFAULT_SUBJECT,
        iss: DEFAULT_ISSUER,
        ...claims,
      });
    },
    teardown(): void {
      nock.cleanAll();
      nock.enableNetConnect();
      tufRepo.teardown();
    },
  };
}

/**
 * Register a persistent nock interceptor for a `@sigstore/mock`
 * service handler. Persistence matters: a suite signs more than once
 * per stack, and nock interceptors are single-use by default.
 */
function mount(baseURL: string, handler: MockServiceHandler): void {
  nock(baseURL)
    .persist()
    .post(handler.path)
    .reply(async (_uri, requestBody) => {
      const raw =
        typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody);
      const { statusCode, response, contentType } = await handler.fn(raw);
      return [statusCode, response, { 'Content-Type': contentType ?? 'text/plain' }];
    });
}

/**
 * Mint an unsigned JWT-shaped token (`<b64url-header>.<b64url-payload>.`)
 * that JWT decoders parse without signature verification — all the
 * mock Fulcio does with it.
 */
function mintUnsignedJwt(payload: Record<string, unknown>): string {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=+$/u, '')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_');
}

/** Base64-encode an ArrayBufferView's exact byte range. */
function toBase64(view: ArrayBufferView): string {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString(
    'base64',
  );
}

// CA / CTLog / TLog types are internal to `@sigstore/mock`'s public
// factory functions — re-derived above via ReturnType so this module
// never deep-imports upstream internals.
export type { CA as MockCA, CTLog as MockCTLog, TLog as MockTLog };
