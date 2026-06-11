/**
 * `ggui gadget publish` tests. Exercises the publish core end-to-end
 * with all network + key IO mocked. Each test pins its own temp
 * `~/.ggui` via `GGUI_CONFIG_DIR` so the operator's real keys + login
 * session are never touched.
 *
 * Coverage matrix (Slice 3.4 brief, §Tests):
 *   - Three-layer registry resolution: flag > env > ggui.json > error
 *   - Missing manifest → clear error
 *   - Invalid manifest → zod issue message
 *   - Conformance preflight fails → exit 1, no upload
 *   - Auth fails (no session / expired session / refresh rejected) → exit 1
 *   - Login-session refresh path rotates + persists tokens
 *   - Registry 401 → vendor-neutral auth diagnosis, per credential kind
 *   - Signing key missing → generate prompt OR error with hint
 *   - Server returns 501 → friendly message, exit 1
 *   - Server returns 201 → install command printed correctly
 *   - --dry-run → no POST happens
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArtifactPublishFlags,
  resolveRegistryUrl,
  runArtifactPublish,
  type ArtifactPublishOptions,
} from './artifact-publish.js';
import { saveAuthSession, tryLoadAuthSession } from '../auth-store.js';
import {
  generateEd25519Keypair,
  signBundleEd25519,
  derivePublicKeyId,
  publicKeyFromPrivate,
} from '@ggui-ai/gadget-signing';
import { sha384 } from '@noble/hashes/sha512.js';

// Mimic the agent's removed `computeSha384` helper using the same
// noble primitive the workspace package uses internally — keeps the
// roundtrip-signature test as a black-box check.
const computeSha384 = (bytes: Uint8Array): string =>
  Buffer.from(sha384(bytes)).toString('base64');

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

// Bucket B'' (LOCKED-24): visibility now drives the signing dispatch
// (`private` → Ed25519, `public` → sigstore keyless). The Ed25519-path
// tests below use a `private` manifest so they exercise the existing
// keypair flow; a parallel `public` fixture below drives the sigstore
// dispatch test.
const VALID_GADGET = {
  kind: 'gadget',
  scope: '@mapbox',
  name: 'map-gadget',
  version: '0.1.0',
  bundle: 'src/index.ts',
  visibility: 'private',
  peerDeps: { 'mapbox-gl': '^3' },
  description: 'Mapbox map gadget',
  exports: [
    {
      hook: 'useMapboxMap',
      description: 'Mapbox map gadget',
      usage:
        'Use whenever the agent needs to render a Mapbox-backed map for the user.',
      example: { center: [0, 0], zoom: 2 },
    },
  ],
};

const VALID_PUBLIC_GADGET = {
  ...VALID_GADGET,
  visibility: 'public',
};

const VALID_BLUEPRINT = {
  kind: 'blueprint',
  scope: '@you',
  name: 'login-form',
  version: '1.0.0',
  visibility: 'private',
  source: 'export default function () { return null; }',
};

// Sample bundle source — a trivial ESM module esbuild will happily
// bundle without any peerDeps actually being installed.
const SAMPLE_SOURCE = `export const hello = () => 'world';\n`;

interface TestEnv {
  readonly homeDir: string;
  readonly repoDir: string;
}

function setupTestEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), 'ggui-publish-'));
  const homeDir = join(root, 'home');
  const repoDir = join(root, 'repo');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  process.env['GGUI_CONFIG_DIR'] = homeDir;
  return { homeDir, repoDir };
}

function teardownTestEnv(env: TestEnv): void {
  delete process.env['GGUI_CONFIG_DIR'];
  delete process.env['GGUI_REGISTRY'];
  delete process.env['GGUI_OIDC_TOKEN'];
  delete process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
  delete process.env['ACTIONS_ID_TOKEN_REQUEST_URL'];
  rmSync(env.homeDir, { recursive: true, force: true });
  rmSync(env.repoDir, { recursive: true, force: true });
}

/** Build a fetch stub that responds to known URLs with canned data. */
function makeFetchStub(handlers: Record<string, Mock>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    for (const [pathSuffix, handler] of Object.entries(handlers)) {
      if (u.endsWith(pathSuffix)) {
        return handler(u, init);
      }
    }
    throw new Error(`fetch stub: unexpected URL ${u}`);
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The fixed clock every publish test runs on (unix epoch SECONDS).
 * Session fixtures below are expressed relative to it.
 */
const TEST_NOW = 1_700_000_000;

/**
 * Seed a fresh `ggui login` session at the temp `~/.ggui/auth.json`.
 * Access token valid for another 2h relative to TEST_NOW — the
 * publish flow uses it without refreshing.
 */
function seedLoginSession(
  overrides: Partial<{
    accessToken: string;
    accessExpiresAt: number;
    refreshToken: string;
    refreshExpiresAt: number;
  }> = {},
): void {
  saveAuthSession({
    version: 1,
    endpoint: 'https://api.example',
    userId: 'user-123',
    sessionId: 'sess-123',
    accessToken: overrides.accessToken ?? 'cli_at_fresh',
    accessExpiresAt: overrides.accessExpiresAt ?? TEST_NOW + 7200,
    refreshToken: overrides.refreshToken ?? 'cli_rt_fresh',
    refreshExpiresAt: overrides.refreshExpiresAt ?? TEST_NOW + 30 * 24 * 3600,
    clientName: 'test client',
    writtenAt: '2026-06-11T00:00:00.000Z',
  });
}

/** Write a minimal valid gadget repo (manifest + entry). */
function seedGadgetRepo(repoDir: string): void {
  writeFileSync(
    join(repoDir, 'ggui.gadget.json'),
    JSON.stringify(VALID_GADGET, null, 2),
  );
  mkdirSync(join(repoDir, 'src'));
  writeFileSync(join(repoDir, 'src', 'index.ts'), SAMPLE_SOURCE);
}

function seedBlueprintRepo(repoDir: string): void {
  writeFileSync(
    join(repoDir, 'ggui.blueprint.json'),
    JSON.stringify(VALID_BLUEPRINT, null, 2),
  );
}

/** Write a minimal valid PUBLIC gadget repo (visibility=public) for the
 * sigstore-dispatch test. */
function seedPublicGadgetRepo(repoDir: string): void {
  writeFileSync(
    join(repoDir, 'ggui.gadget.json'),
    JSON.stringify(VALID_PUBLIC_GADGET, null, 2),
  );
  mkdirSync(join(repoDir, 'src'));
  writeFileSync(join(repoDir, 'src', 'index.ts'), SAMPLE_SOURCE);
}

/**
 * Set process.env for the duration of a test; returns a restore
 * thunk that's safe to call in a `finally` block. Only mutates keys
 * named in `vars` so other env state stays intact.
 */
function withEnv(vars: Record<string, string>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, prev] of Object.entries(previous)) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
}

function captureIO(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly stdoutFn: (s: string) => void;
  readonly stderrFn: (s: string) => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutFn: (s) => stdout.push(s),
    stderrFn: (s) => stderr.push(s),
  };
}

// ---------------------------------------------------------------------------
// parseArtifactPublishFlags
// ---------------------------------------------------------------------------

describe('parseArtifactPublishFlags', () => {
  it('parses --registry, --dry-run, --key together', () => {
    const f = parseArtifactPublishFlags([
      '--registry',
      'https://r.example',
      '--dry-run',
      '--key',
      '/path/to/key',
    ]);
    expect(f.error).toBeUndefined();
    expect(f.registry).toBe('https://r.example');
    expect(f.dryRun).toBe(true);
    expect(f.key).toBe('/path/to/key');
  });

  it('returns help on --help', () => {
    const f = parseArtifactPublishFlags(['--help']);
    expect(f.help).toBe(true);
  });

  it('errors on missing --registry value', () => {
    const f = parseArtifactPublishFlags(['--registry']);
    expect(f.error).toBe('--registry requires a value');
  });

  it('errors on unknown flag', () => {
    const f = parseArtifactPublishFlags(['--bogus']);
    expect(f.error).toBe('unknown flag: --bogus');
  });

  // Bucket B'' (LOCKED-24): `--identity-token <jwt>` carries the OIDC
  // identity token through to the sigstore signer for public-gadget
  // publishes. Mirrors cosign's flag convention.
  it('parses --identity-token <jwt> (space form)', () => {
    const f = parseArtifactPublishFlags(['--identity-token', 'header.payload.sig']);
    expect(f.error).toBeUndefined();
    expect(f.identityToken).toBe('header.payload.sig');
  });

  it('parses --identity-token=<jwt> (equals form)', () => {
    const f = parseArtifactPublishFlags(['--identity-token=header.payload.sig']);
    expect(f.error).toBeUndefined();
    expect(f.identityToken).toBe('header.payload.sig');
  });

  it('errors on missing --identity-token value', () => {
    const f = parseArtifactPublishFlags(['--identity-token']);
    expect(f.error).toBe('--identity-token requires a value');
  });
});

// ---------------------------------------------------------------------------
// resolveRegistryUrl — three-layer
// ---------------------------------------------------------------------------

describe('resolveRegistryUrl', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupTestEnv();
  });
  afterEach(() => teardownTestEnv(env));

  it('flag wins over env wins over ggui.json', () => {
    process.env['GGUI_REGISTRY'] = 'https://from-env.example';
    writeFileSync(
      join(env.repoDir, 'ggui.json'),
      JSON.stringify({ schema: '1', registry: 'https://from-json.example' }),
    );
    const flag = resolveRegistryUrl({
      flag: 'https://from-flag.example',
      env: process.env,
      cwd: env.repoDir,
    });
    expect(flag.ok).toBe(true);
    if (flag.ok) {
      expect(flag.url).toBe('https://from-flag.example');
      expect(flag.source).toBe('flag');
    }
  });

  it('env wins over ggui.json when flag absent', () => {
    process.env['GGUI_REGISTRY'] = 'https://from-env.example';
    writeFileSync(
      join(env.repoDir, 'ggui.json'),
      JSON.stringify({ schema: '1', registry: 'https://from-json.example' }),
    );
    const r = resolveRegistryUrl({ env: process.env, cwd: env.repoDir });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('https://from-env.example');
      expect(r.source).toBe('env');
    }
  });

  it('falls back to ggui.json#registry when flag + env absent', () => {
    writeFileSync(
      join(env.repoDir, 'ggui.json'),
      JSON.stringify({ schema: '1', registry: 'https://from-json.example/' }),
    );
    const r = resolveRegistryUrl({ env: process.env, cwd: env.repoDir });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('https://from-json.example');
      expect(r.source).toBe('ggui.json');
    }
  });

  it('walks UP from cwd to find ggui.json', () => {
    const sub = join(env.repoDir, 'sub', 'nested');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(env.repoDir, 'ggui.json'),
      JSON.stringify({ schema: '1', registry: 'https://parent.example' }),
    );
    const r = resolveRegistryUrl({ env: process.env, cwd: sub });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toBe('ggui.json');
  });

  it('errors when no registry can be resolved', () => {
    const r = resolveRegistryUrl({ env: process.env, cwd: env.repoDir });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('no registry resolved');
      expect(r.message).toContain('--registry');
      expect(r.message).toContain('GGUI_REGISTRY');
      expect(r.message).toContain('ggui.json');
    }
  });

  it('rejects an invalid registry URL on the flag', () => {
    const r = resolveRegistryUrl({
      flag: 'not-a-url',
      env: process.env,
      cwd: env.repoDir,
    });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runArtifactPublish — end-to-end with mocks
// ---------------------------------------------------------------------------

describe('runArtifactPublish', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => teardownTestEnv(env));

  function baseOpts(extra: Partial<ArtifactPublishOptions> = {}): ArtifactPublishOptions {
    const io = captureIO();
    return {
      kind: 'gadget',
      registry: 'https://r.example',
      dryRun: false,
      cwd: env.repoDir,
      stdout: io.stdoutFn,
      stderr: io.stderrFn,
      now: () => 1_700_000_000,
      ...extra,
    };
  }

  it('errors when no manifest in CWD', async () => {
    const io = captureIO();
    const result = await runArtifactPublish({
      kind: 'gadget',
      registry: 'https://r.example',
      dryRun: false,
      cwd: env.repoDir,
      stdout: io.stdoutFn,
      stderr: io.stderrFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('manifest_missing');
    expect(io.stderr.join('')).toContain('no ggui.gadget.json or ggui.blueprint.json');
  });

  it('errors when manifest fails schema validation', async () => {
    writeFileSync(
      join(env.repoDir, 'ggui.gadget.json'),
      JSON.stringify({ kind: 'gadget', artifactId: 'no-slash' }),
    );
    const io = captureIO();
    const result = await runArtifactPublish({
      kind: 'gadget',
      registry: 'https://r.example',
      dryRun: false,
      cwd: env.repoDir,
      stdout: io.stdoutFn,
      stderr: io.stderrFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('manifest_invalid');
  });

  it('errors with auth_config_missing when not signed in (no auth.json)', async () => {
    seedGadgetRepo(env.repoDir);
    const io = captureIO();
    const result = await runArtifactPublish({
      kind: 'gadget',
      registry: 'https://r.example',
      dryRun: false,
      cwd: env.repoDir,
      stdout: io.stdoutFn,
      stderr: io.stderrFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('auth_config_missing');
      // Vendor-neutral guidance: sign in OR bring a bearer token.
      expect(result.error.message).toContain('ggui login');
      expect(result.error.message).toContain('--auth=bearer');
      expect(result.error.message).toContain('GGUI_REGISTRY_TOKEN');
    }
  });

  it('manifest_kind_mismatch: `ggui gadget publish` on blueprint repo → friendly redirect', async () => {
    seedBlueprintRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const result = await runArtifactPublish(
      baseOpts({
        // kind defaults to 'gadget' in baseOpts; manifest in CWD is blueprint.
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('manifest_kind_mismatch');
    expect(io.stderr.join('')).toContain('blueprint repo');
    expect(io.stderr.join('')).toContain('ggui blueprint publish');
  });

  it('manifest_kind_mismatch: `ggui blueprint publish` on gadget repo → friendly redirect', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const result = await runArtifactPublish(
      baseOpts({
        kind: 'blueprint',
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('manifest_kind_mismatch');
    expect(io.stderr.join('')).toContain('gadget repo');
    expect(io.stderr.join('')).toContain('ggui gadget publish');
  });

  it('happy path — gadget bundles, signs, posts, prints install command', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();

    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const publish = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(201, {
        artifactId: '@mapbox/map-gadget',
        version: '0.1.0',
        manifestUrl: 'https://r.example/p/@mapbox/map-gadget/0.1.0/manifest.json',
        bundleUrl: 'https://r.example/p/@mapbox/map-gadget/0.1.0/bundle.js',
        signatureUrl: 'https://r.example/p/@mapbox/map-gadget/0.1.0/sig.json',
        installCommand:
          'ggui gadget install @mapbox/map-gadget@0.1.0 --registry=https://r.example',
      }),
    );

    const result = await runArtifactPublish(
      baseOpts({
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(conformance).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.success.artifactId).toBe('@mapbox/map-gadget');
      expect(result.success.installCommand).toContain('--registry=https://r.example');
    }
    expect(io.stdout.join('')).toContain('Install:');

    // Verify the POST body shape
    const publishCall = publish.mock.calls[0];
    expect(publishCall[1]?.method).toBe('POST');
    const headers = publishCall[1]?.headers as Record<string, string>;
    expect(headers?.['Authorization']).toBe('Bearer cli_at_fresh');
    const body = JSON.parse(publishCall[1]?.body as string);
    expect(body.manifest.kind).toBe('gadget');
    expect(typeof body.bundle).toBe('string'); // base64
    expect(body.bundleSha384).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(body.signature.algorithm).toBe('ed25519');
    // publicKeyId is a 16-char base64 hash (no algorithm prefix —
    // algorithm lives on signature.algorithm).
    expect(body.signature.publicKeyId).toMatch(/^[A-Za-z0-9+/]{16}$/);
    expect(typeof body.signature.signature).toBe('string');
  });

  it('conformance preflight fails → exit 1, no POST to /publish', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const conformance = vi.fn(async () =>
      jsonResponse(200, {
        ok: false,
        issues: [
          { code: 'bundle_too_large', message: 'bundle exceeds 5MB' },
        ],
      }),
    );
    const publish = vi.fn();

    const result = await runArtifactPublish(
      baseOpts({
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conformance_failed');
      if (result.error.code === 'conformance_failed') {
        expect(result.error.issues?.[0].code).toBe('bundle_too_large');
      }
    }
    expect(publish).not.toHaveBeenCalled();
    expect(io.stderr.join('')).toContain('bundle_too_large');
  });

  it('auth fails when the session refresh is rejected → exit 1, `ggui login` hint', async () => {
    seedGadgetRepo(env.repoDir);
    // Access token already expired; refresh token still within TTL —
    // the CLI attempts /v1/auth/refresh and the server rejects it.
    seedLoginSession({ accessExpiresAt: TEST_NOW - 10 });
    const io = captureIO();
    const refresh = vi.fn(async () =>
      jsonResponse(401, {
        error: 'invalid_grant',
        error_description: 'refresh token revoked',
      }),
    );
    const result = await runArtifactPublish(
      baseOpts({
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({ '/v1/auth/refresh': refresh }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('auth_failed');
      expect(result.error.message).toContain('ggui login');
    }
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('auth fails without a network call when the refresh token itself expired', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession({
      accessExpiresAt: TEST_NOW - 100,
      refreshExpiresAt: TEST_NOW - 10,
    });
    const io = captureIO();
    const result = await runArtifactPublish(
      baseOpts({
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        // Empty stub — ANY fetch would throw "unexpected URL".
        fetch: makeFetchStub({}),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('auth_failed');
      expect(result.error.message).toContain('ggui login');
    }
  });

  it('server returns 501 → friendly message, exit 1', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const publish = vi.fn(async () => new Response('', { status: 501 }));

    const result = await runArtifactPublish(
      baseOpts({
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('publish_stubbed');
    expect(io.stderr.join('')).toContain('not yet live');
  });

  it('--dry-run → no POST to /publish', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const publish = vi.fn();

    const result = await runArtifactPublish(
      baseOpts({
        dryRun: true,
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.success.dryRun).toBe(true);
      expect(result.success.installCommand).toContain('--registry=https://r.example');
    }
    expect(publish).not.toHaveBeenCalled();
    expect(conformance).toHaveBeenCalledTimes(1);
    expect(io.stdout.join('')).toContain('dry-run');
  });

  it('first-publish generates a signing key + prints publicKeyId', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const publish = vi.fn(async () =>
      jsonResponse(201, {
        artifactId: '@mapbox/map-gadget',
        version: '0.1.0',
        manifestUrl: 'm',
        installCommand: 'install',
      }),
    );

    const result = await runArtifactPublish(
      baseOpts({
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(io.stdout.join('')).toContain('generated new keypair');
    // publicKeyId is a base64-encoded 16-char hash (per
    // `derivePublicKeyId` in @ggui-ai/gadget-signing); no `ed25519:`
    // algorithm prefix. The signature object carries `algorithm` on
    // a separate field.
    expect(io.stdout.join('')).toMatch(/publicKeyId=[A-Za-z0-9+/]{16}/);
  });

  it('--key path that does not exist → exit 1 with key_missing', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const result = await runArtifactPublish(
      baseOpts({
        key: '/nonexistent/path/key',
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('key_missing');
  });

  // Bucket B'' (LOCKED-24): visibility-branch dispatch — public manifests
  // route through `signBundleSigstore` + the OIDC token chain. We stub
  // `signBundleSigstore` (gadget-signing currently ships a `_input: never`
  // stub) via the `GGUI_OIDC_TOKEN` env source to skip the OIDC flow,
  // and pin via `vi.mock` that the sigstore signer was invoked.
  //
  // The mock returns a structurally-valid `SigstoreSignature` so the
  // wire format the POST body carries matches the registry contract.
  it('public gadget routes to signBundleSigstore + posts sigstore signature', async () => {
    // Reset module cache so the next dynamic import re-evaluates the
    // publish module + picks up the doMock'd signBundleSigstore. (The
    // top-of-file static import already cached the real signer, which
    // throws SigstoreNotImplementedError until Agent A's stub-widen
    // commit lands.)
    vi.resetModules();
    vi.doMock('@ggui-ai/gadget-signing', async () => {
      const actual = await vi.importActual<
        typeof import('@ggui-ai/gadget-signing')
      >('@ggui-ai/gadget-signing');
      return {
        ...actual,
        signBundleSigstore: vi.fn(async (input: { bundleBytes: Uint8Array; identityToken: string }) => {
          // Bare structural shape — `SigstoreSignature` from gadget-signing.
          return {
            algorithm: 'sigstore-cosign' as const,
            bundleSha384: Buffer.from(input.bundleBytes).toString('base64').slice(0, 16),
            bundle: JSON.stringify({ mock: true, identityTokenLen: input.identityToken.length }),
            signedAt: new Date().toISOString(),
          };
        }),
      };
    });
    // Re-import the publish module so it picks up the mocked signer.
    const { runArtifactPublish: runWithMock } = await import('./artifact-publish.js');

    seedPublicGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const publish = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(201, {
        artifactId: '@mapbox/map-gadget',
        version: '0.1.0',
        manifestUrl: 'm',
        installCommand: 'i',
      }),
    );

    const restore = withEnv({ GGUI_OIDC_TOKEN: 'env-oidc-jwt' });
    try {
      const result = await runWithMock({
        kind: 'gadget',
        dryRun: false,
        cwd: env.repoDir,
        registry: 'https://r.example',
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
        now: () => 1_700_000_000,
      });
      expect(result.ok).toBe(true);
    } finally {
      restore();
      vi.doUnmock('@ggui-ai/gadget-signing');
    }

    const body = JSON.parse(publish.mock.calls[0][1]?.body as string);
    expect(body.signature.algorithm).toBe('sigstore-cosign');
    expect(typeof body.signature.bundle).toBe('string');
    expect(typeof body.signature.bundleSha384).toBe('string');
    expect(io.stdout.join('')).toContain('sigstore');
    expect(io.stdout.join('')).toContain('OIDC source=env');
  });

  // Bucket B'' (LOCKED-24): when visibility=public but no OIDC token
  // can be resolved (no flag, no env, no GH-Actions ambient, no TTY),
  // surface a structured `oidc_resolution_failed` error.
  it('public gadget without resolvable OIDC token → oidc_resolution_failed', async () => {
    seedPublicGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const publish = vi.fn();

    // Ensure no token sources are present (the global teardown clears
    // some of these, but be explicit here).
    delete process.env['GGUI_OIDC_TOKEN'];
    delete process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
    delete process.env['ACTIONS_ID_TOKEN_REQUEST_URL'];

    const result = await runArtifactPublish(
      baseOpts({
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('oidc_resolution_failed');
      if (result.error.code === 'oidc_resolution_failed') {
        expect(result.error.oidcCode).toBe('no_token_available');
      }
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('blueprint manifest signs canonical JSON (no bundle)', async () => {
    seedBlueprintRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const publish = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(201, {
        artifactId: '@you/login-form',
        version: '1.0.0',
        manifestUrl: 'https://r.example/p/manifest.json',
        installCommand: 'ggui install @you/login-form@1.0.0 --registry=https://r.example',
      }),
    );

    const result = await runArtifactPublish(
      baseOpts({
        kind: 'blueprint',
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );
    expect(result.ok).toBe(true);
    const body = JSON.parse(publish.mock.calls[0][1]?.body as string);
    expect(body.manifest.kind).toBe('blueprint');
    expect(body.bundle).toBeUndefined();
    expect(body.bundleSha384).toBeUndefined();
    expect(body.signature.algorithm).toBe('ed25519');
  });

  it('returns no_registry_resolved when none of flag/env/ggui.json is set', async () => {
    seedGadgetRepo(env.repoDir);
    const io = captureIO();
    const result = await runArtifactPublish({
      kind: 'gadget',
      dryRun: false,
      cwd: env.repoDir,
      stdout: io.stdoutFn,
      stderr: io.stderrFn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('no_registry_resolved');
  });

  // De-Cognito (2026-06-11): the publish flow's default credential is
  // the `ggui login` session. An expired access token is refreshed
  // against the session's OWN endpoint (auth.json#endpoint), never the
  // registry, and the rotated tokens are persisted.
  it('refreshes an expired login session and persists the rotated tokens', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession({ accessExpiresAt: TEST_NOW - 10 });
    const io = captureIO();
    const refresh = vi.fn(async (url: string) => {
      // The refresh MUST hit the session's endpoint, not the registry.
      expect(url).toBe('https://api.example/v1/auth/refresh');
      return jsonResponse(200, {
        access_token: 'cli_at_rotated',
        refresh_token: 'cli_rt_rotated',
        token_type: 'Bearer',
        expires_in: 900,
        session_id: 'sess-123',
      });
    });
    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const publish = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(201, {
        artifactId: '@mapbox/map-gadget',
        version: '0.1.0',
        manifestUrl: 'm',
        installCommand: 'i',
      }),
    );

    const result = await runArtifactPublish(
      baseOpts({
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/v1/auth/refresh': refresh,
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(io.stdout.join('')).toContain('(refreshed)');

    // The registry calls carry the ROTATED access token.
    const headers = publish.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers?.['Authorization']).toBe('Bearer cli_at_rotated');

    // The rotated session was persisted back to auth.json.
    const persisted = tryLoadAuthSession();
    expect(persisted?.accessToken).toBe('cli_at_rotated');
    expect(persisted?.refreshToken).toBe('cli_rt_rotated');
    expect(persisted?.accessExpiresAt).toBe(TEST_NOW + 900);
  });

  // De-Cognito (2026-06-11): the hosted registry does not accept CLI
  // login sessions server-side yet — a 401 while using the session
  // credential must say so truthfully (vendor-neutrally) instead of
  // masquerading as a conformance failure.
  it('registry 401 with session auth → auth_failed naming the bearer alternative', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(401, { message: 'Unauthorized' }));
    const publish = vi.fn();
    const result = await runArtifactPublish(
      baseOpts({
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('auth_failed');
      expect(result.error.message).toContain('ggui login');
      expect(result.error.message).toContain('--auth=bearer');
      // OSS purity: no identity-provider vendor in operator-facing text.
      expect(result.error.message.toLowerCase()).not.toContain('cognito');
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('registry 401 with bearer auth → auth_failed pointing at the configured token', async () => {
    seedGadgetRepo(env.repoDir);
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(401, { message: 'Unauthorized' }));
    const result = await runArtifactPublish(
      baseOpts({
        auth: { auth: 'bearer', token: 'static-publish-token' },
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({ '/conformance/check': conformance }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('auth_failed');
      expect(result.error.message).toContain('GGUI_REGISTRY_TOKEN');
    }
  });

  it('bearer auth works without any login session on disk', async () => {
    seedGadgetRepo(env.repoDir);
    // NO seedLoginSession() — the bearer path must never read auth.json.
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const publish = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(201, {
        artifactId: '@mapbox/map-gadget',
        version: '0.1.0',
        manifestUrl: 'm',
        installCommand: 'i',
      }),
    );
    const result = await runArtifactPublish(
      baseOpts({
        auth: { auth: 'bearer', token: 'static-publish-token' },
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );
    expect(result.ok).toBe(true);
    const headers = publish.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers?.['Authorization']).toBe('Bearer static-publish-token');
  });

  it('publish 400 with structured server code → surfaces serverCode', async () => {
    seedGadgetRepo(env.repoDir);
    seedLoginSession();
    const io = captureIO();
    const conformance = vi.fn(async () => jsonResponse(200, { ok: true }));
    const publish = vi.fn(async () =>
      jsonResponse(400, { code: 'version_exists', message: '0.1.0 already published' }),
    );
    const result = await runArtifactPublish(
      baseOpts({
        stdout: io.stdoutFn,
        stderr: io.stderrFn,
        fetch: makeFetchStub({
          '/conformance/check': conformance,
          '/publish': publish,
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'publish_failed') {
      expect(result.error.serverCode).toBe('version_exists');
      expect(result.error.httpStatus).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// gadget-signing primitives — verify the signer actually produces a
// valid Ed25519 signature so the registry's verifier will accept it.
// ---------------------------------------------------------------------------

describe('signBundleEd25519', () => {
  it('round-trips: generate → sign → verify', async () => {
    const kp = await generateEd25519Keypair();
    const bytes = new TextEncoder().encode('hello world');
    const sig = await signBundleEd25519({
      bundleBytes: bytes,
      privateKey: kp.privateKey,
      publicKeyId: kp.publicKeyId,
    });
    expect(sig.algorithm).toBe('ed25519');
    expect(sig.publicKeyId).toBe(kp.publicKeyId);
    // Verify with node's crypto subtle layer to prove we produced a
    // standards-compliant signature, not just "some bytes".
    const { createPublicKey, verify } = await import('node:crypto');
    const pubKey = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(kp.publicKey).toString('base64url'),
      },
      format: 'jwk',
    });
    // The workspace package signs sha384(bytes), not the raw bytes —
    // the bundleSha384 field on the signature is the actual signed
    // message. Verify against that for a standards-compliant check.
    const ok = verify(null, sha384(bytes), pubKey, Buffer.from(sig.signature, 'base64'));
    expect(ok).toBe(true);
  });

  it('derivePublicKeyId is stable across re-derives', async () => {
    const kp = await generateEd25519Keypair();
    const id1 = derivePublicKeyId(kp.publicKey);
    const id2 = derivePublicKeyId(await publicKeyFromPrivate(kp.privateKey));
    expect(id1).toBe(id2);
  });

  it('computeSha384 matches expected length + format', () => {
    const digest = computeSha384(new TextEncoder().encode('abc'));
    // SHA-384 = 48 bytes = 64 base64 chars (+ optional padding)
    expect(digest.length).toBeGreaterThanOrEqual(64);
  });
});
