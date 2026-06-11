/**
 * `ggui gadget install` unit tests.
 *
 * Mocks global `fetch` + temp `ggui.json` on disk. Each test owns its
 * own temp workdir so the registry-URL chain, app.gadgets
 * mutation, and publicEnv prompt paths are exercised with real disk
 * IO (writeFileSync + parseGguiJson round-trips) instead of in-memory
 * mocks.
 *
 * Two integrity check axes are covered:
 *
 *   - **SRI** — recompute `sha384(bundleBytes)` and compare against
 *     the manifest's published `bundleSri`. Mismatch → exit 1.
 *   - **Ed25519** — recompute the bundleSha384 + check against
 *     `signature.bundleSha384`. Full pubkey verification is gated on
 *     a separate registry surface (`/keys/<id>` route or inline
 *     `authorPublicKey`) — see the W4-B parent agent note in the
 *     install module's docstring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha384 } from '@noble/hashes/sha512.js';

// Hoisted sigstore-verify mock. The real impl in
// `@ggui-ai/gadget-signing` walks Fulcio + Rekor over the network; the
// install-side unit tests stub it so the dispatch wiring is what we pin.
const sigstoreMocks = vi.hoisted(() => ({
  verifyBundleSigstore: vi.fn(),
}));

vi.mock('@ggui-ai/gadget-signing', async () => {
  const actual = await vi.importActual<typeof import('@ggui-ai/gadget-signing')>(
    '@ggui-ai/gadget-signing',
  );
  return {
    ...actual,
    verifyBundleSigstore: sigstoreMocks.verifyBundleSigstore,
  };
});

import {
  derivePublicKeyId,
  generateEd25519Keypair,
  signBundleEd25519,
  type SigstoreSignature,
} from '@ggui-ai/gadget-signing';
import {
  parseArtifactInstallFlags,
  runArtifactInstall,
  type InstallFlags,
} from './artifact-install.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return Buffer.from(bin, 'binary').toString('base64');
}

/**
 * Test-side mirror of the install module's `canonicalJson()` — recursive
 * key-sort then stringify. Must stay bit-equivalent to the production
 * helper so the test's `bundleSha384` matches what install recomputes.
 */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, kv] of Object.entries(v as Record<string, unknown>).sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      )) {
        out[k] = sort(kv);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function setupTempWorkdir(): { workDir: string } {
  const workDir = mkdtempSync(join(tmpdir(), 'ggui-install-'));
  // Seed a minimal valid ggui.json so install can find one + write to it.
  writeFileSync(
    join(workDir, 'ggui.json'),
    JSON.stringify({
      schema: '1',
      app: { slug: 'demo', name: 'Demo' },
    }),
  );
  return { workDir };
}

function tearDown(workDir: string): void {
  rmSync(workDir, { recursive: true, force: true });
}

/** Build a fetch stub that matches request URLs by suffix and returns
 *  the corresponding response. Mirrors gadget-publish.test.ts. */
function makeFetchStub(
  routes: Array<{ matches: (url: string) => boolean; response: Response | Error }>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    for (const route of routes) {
      if (route.matches(url)) {
        if (route.response instanceof Error) throw route.response;
        return route.response;
      }
    }
    throw new Error(`fetch stub: no route matched ${url}`);
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bytesResponse(status: number, bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'application/javascript' },
  });
}

/** Minimal valid gadget manifest body for the registry's read response.
 *  GG.8.1 — a gadget manifest is a PACKAGE: per-export `description` /
 *  `usage` / `example` are required on each `exports[*]` entry; install
 *  passes them through verbatim to the GadgetDescriptor write. The
 *  package-level `description` is a separate required field. */
function gadgetManifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'gadget',
    scope: '@my-org',
    name: 'weather-card',
    version: '0.1.0',
    bundle: 'src/index.ts',
    visibility: 'public',
    description: 'Beautiful weather card',
    exports: [
      {
        hook: 'useWeatherCard',
        description: 'Beautiful weather card',
        usage:
          'Use whenever the agent wants to show current weather for a city.',
        example: { city: 'Berlin' },
      },
    ],
    ...overrides,
  };
}

function blueprintManifestFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'blueprint',
    scope: '@my-org',
    name: 'login-form',
    version: '1.0.0',
    visibility: 'public',
    source: 'export default function () { return null; }',
    ...overrides,
  };
}

/** Build a fake bundle + signature pair signed against a known SHA. */
function buildArtifacts(bundleText: string): {
  bundleBytes: Uint8Array<ArrayBuffer>;
  bundleSri: string;
  signature: {
    algorithm: 'ed25519';
    bundleSha384: string;
    signature: string;
    publicKeyId: string;
    signedAt: string;
  };
} {
  const bundleBytes = new TextEncoder().encode(bundleText);
  const digest = sha384(bundleBytes);
  const bundleSha384 = bytesToBase64(digest);
  const bundleSri = `sha384-${bundleSha384}`;
  return {
    bundleBytes,
    bundleSri,
    signature: {
      algorithm: 'ed25519',
      bundleSha384,
      // Signature bytes are arbitrary here — the test path never runs the
      // full ed25519 verify (the registry doesn't expose the public key
      // yet; install warns + continues unless `--strict`).
      signature: bytesToBase64(new Uint8Array(64)),
      publicKeyId: 'fake-key-id-AAAA',
      signedAt: '2026-05-17T00:00:00Z',
    },
  };
}

/* -------------------------------------------------------------------------- */
/* parseArtifactInstallFlags                                                    */
/* -------------------------------------------------------------------------- */

describe('parseArtifactInstallFlags', () => {
  it('parses <scope/name>@<version>', () => {
    const r = parseArtifactInstallFlags('gadget', ['@my-org/weather-card@0.1.0']);
    expect(r).toEqual({
      kind: 'gadget',
      artifactId: '@my-org/weather-card',
      version: '0.1.0',
      noPrompt: false,
      strict: false,
    });
  });

  it('parses --registry, --no-prompt, --strict together', () => {
    const r = parseArtifactInstallFlags('gadget', [
      '@my-org/foo@1.0.0',
      '--registry',
      'https://r.example.com',
      '--no-prompt',
      '--strict',
    ]);
    expect(r).toEqual({
      kind: 'gadget',
      artifactId: '@my-org/foo',
      version: '1.0.0',
      registry: 'https://r.example.com',
      noPrompt: true,
      strict: true,
    });
  });

  it('accepts --registry=value form', () => {
    const r = parseArtifactInstallFlags('gadget', [
      '@x/y@1.0.0',
      '--registry=https://r.example.com',
    ]);
    expect('error' in r ? r.error : '').toBe('');
    if (!('error' in r)) {
      expect(r.registry).toBe('https://r.example.com');
    }
  });

  it('returns __help__ on --help / -h', () => {
    expect(parseArtifactInstallFlags('gadget', ['--help'])).toEqual({ error: '__help__' });
    expect(parseArtifactInstallFlags('gadget', ['-h'])).toEqual({ error: '__help__' });
  });

  it('stamps blueprint kind onto flags when called with kind="blueprint"', () => {
    const r = parseArtifactInstallFlags('blueprint', ['@my-org/login-form@1.0.0']);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.kind).toBe('blueprint');
    }
  });

  it('rejects positional missing @version', () => {
    const r = parseArtifactInstallFlags('gadget', ['foo']);
    expect('error' in r && r.error).toMatch(/invalid install identifier/);
  });

  it('rejects artifactId without leading @', () => {
    const r = parseArtifactInstallFlags('gadget', ['my-org/foo@1.0.0']);
    expect('error' in r && r.error).toMatch(/invalid artifactId/);
  });

  it('rejects artifactId missing /name', () => {
    const r = parseArtifactInstallFlags('gadget', ['@my-org@1.0.0']);
    expect('error' in r && r.error).toMatch(/invalid artifactId/);
  });

  it('rejects empty version', () => {
    const r = parseArtifactInstallFlags('gadget', ['@my-org/foo@']);
    expect('error' in r && r.error).toMatch(/invalid version/);
  });

  it('rejects missing positional', () => {
    const r = parseArtifactInstallFlags('gadget', ['--registry', 'https://r.example.com']);
    expect('error' in r && r.error).toMatch(/missing positional argument/);
  });

  it('rejects unknown flag', () => {
    const r = parseArtifactInstallFlags('gadget', ['@x/y@1.0.0', '--bogus']);
    expect('error' in r && r.error).toMatch(/unknown flag/);
  });

  it('rejects --registry without value', () => {
    const r = parseArtifactInstallFlags('gadget', ['@x/y@1.0.0', '--registry']);
    expect('error' in r && r.error).toMatch(/requires a value/);
  });

  it('rejects two positionals', () => {
    const r = parseArtifactInstallFlags('gadget', ['@x/y@1.0.0', 'extra']);
    expect('error' in r && r.error).toMatch(/unexpected positional/);
  });

  it('parses --verify-identity <pattern> as literal subject', () => {
    const r = parseArtifactInstallFlags('gadget', [
      '@my-org/weather@1.0.0',
      '--verify-identity',
      'alice@example.com',
    ]);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.verifyIdentity).toBe('alice@example.com');
    }
  });

  it('parses --verify-identity=value form', () => {
    const r = parseArtifactInstallFlags('gadget', [
      '@my-org/weather@1.0.0',
      '--verify-identity=/^.+@example\\.com$/',
    ]);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.verifyIdentity).toBe('/^.+@example\\.com$/');
    }
  });

  it('rejects --verify-identity without value', () => {
    const r = parseArtifactInstallFlags('gadget', [
      '@my-org/weather@1.0.0',
      '--verify-identity',
    ]);
    expect('error' in r && r.error).toMatch(/--verify-identity requires a value/);
  });
});

/* -------------------------------------------------------------------------- */
/* runArtifactInstall — happy path + failure modes                              */
/* -------------------------------------------------------------------------- */

describe('runArtifactInstall', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = setupTempWorkdir().workDir;
  });
  afterEach(() => tearDown(workDir));

  interface FlagsBuilderInput {
    kind?: 'gadget' | 'blueprint';
    artifactId: string;
    version: string;
    registry?: string;
    noPrompt?: boolean;
    strict?: boolean;
  }

  interface CapturedIO {
    stdout: string[];
    stderr: string[];
    flags: (f: FlagsBuilderInput) => InstallFlags;
  }

  function captureIO(): CapturedIO {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdout,
      stderr,
      flags: (f: FlagsBuilderInput): InstallFlags => ({
        kind: f.kind ?? 'gadget',
        artifactId: f.artifactId,
        version: f.version,
        registry: f.registry ?? 'https://r.example.com',
        noPrompt: f.noPrompt ?? true,
        strict: f.strict ?? false,
      }),
    };
  }

  it('happy path: gadget — fetches /pkg, downloads bundle, verifies SRI, writes ggui.json', async () => {
    const { bundleBytes, bundleSri, signature } = buildArtifacts(
      'export const useWeatherCard = () => null;',
    );
    const readPkg = {
      manifest: gadgetManifestFixture(),
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri,
      signatureUrl: 'https://cdn.example/bundle.js.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };

    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js',
        response: bytesResponse(200, bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js.sig',
        response: jsonResponse(200, signature),
      },
    ]);

    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );

    expect(code).toBe(0);
    // Round-trip: read the mutated ggui.json + assert the new entry landed.
    const written = JSON.parse(
      readFileSync(join(workDir, 'ggui.json'), 'utf-8'),
    ) as { app: { gadgets: Array<Record<string, unknown>> } };
    expect(written.app.gadgets).toHaveLength(1);
    expect(written.app.gadgets[0]).toMatchObject({
      package: '@my-org/weather-card',
      version: '0.1.0',
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri,
      exports: [expect.objectContaining({ hook: 'useWeatherCard' })],
    });
  });

  it('full verify: authorPublicKey present → runs real Ed25519 verify and writes ggui.json', async () => {
    const bundleBytes = new TextEncoder().encode('export const useFoo = () => null;');
    const bundleSha = bytesToBase64(sha384(bundleBytes));
    const bundleSri = `sha384-${bundleSha}`;
    const { privateKey, publicKey } = await generateEd25519Keypair();
    const publicKeyId = await derivePublicKeyId(publicKey);
    const signature = await signBundleEd25519({
      bundleBytes,
      privateKey,
      publicKeyId,
    });
    const readPkg = {
      manifest: gadgetManifestFixture(),
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri,
      signatureUrl: 'https://cdn.example/bundle.js.sig',
      authorPublicKey: bytesToBase64(publicKey),
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js',
        response: bytesResponse(200, bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js.sig',
        response: jsonResponse(200, signature),
      },
    ]);

    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0', strict: true }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );

    expect(code).toBe(0);
    expect(io.stdout.join('')).toContain('Ed25519 ok');
    // Even with --strict, a verifiable pubkey means we DO write.
    const written = JSON.parse(
      readFileSync(join(workDir, 'ggui.json'), 'utf-8'),
    ) as { app: { gadgets: Array<Record<string, unknown>> } };
    expect(written.app.gadgets).toHaveLength(1);
  });

  it('full verify: tampered bundle with valid signature on original → Ed25519 verify fails, exit 1', async () => {
    const originalBytes = new TextEncoder().encode('export const useFoo = () => null;');
    const tamperedBytes = new TextEncoder().encode('export const useFoo = () => "evil";');
    const { privateKey, publicKey } = await generateEd25519Keypair();
    const publicKeyId = await derivePublicKeyId(publicKey);
    // Signature is for the ORIGINAL bytes, but registry serves the
    // TAMPERED bytes + a matching bundleSri/sha384 (simulating an
    // attacker who recomputed the SRI but can't forge the pubkey sig).
    const signature = await signBundleEd25519({
      bundleBytes: originalBytes,
      privateKey,
      publicKeyId,
    });
    const tamperedSha = bytesToBase64(sha384(tamperedBytes));
    const readPkg = {
      manifest: gadgetManifestFixture(),
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri: `sha384-${tamperedSha}`,
      signatureUrl: 'https://cdn.example/bundle.js.sig',
      authorPublicKey: bytesToBase64(publicKey),
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js',
        response: bytesResponse(200, tamperedBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js.sig',
        response: jsonResponse(200, signature),
      },
    ]);

    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );

    expect(code).toBe(1);
    // bundleSha384 mismatch fires first (the signature was for the
    // original bytes; tamperedBytes hash != signature.bundleSha384).
    expect(io.stderr.join('')).toMatch(/bundleSha384 mismatch/);
  });

  it('full verify: publicKeyId mismatch between signature and pinned key → exit 1', async () => {
    const bundleBytes = new TextEncoder().encode('export const useFoo = () => null;');
    const bundleSha = bytesToBase64(sha384(bundleBytes));
    const { privateKey, publicKey } = await generateEd25519Keypair();
    // Real signature with real publicKeyId derived from `publicKey`...
    const signature = await signBundleEd25519({
      bundleBytes,
      privateKey,
      publicKeyId: await derivePublicKeyId(publicKey),
    });
    // ...but the registry pinned a DIFFERENT public key on this row.
    const { publicKey: wrongKey } = await generateEd25519Keypair();
    const readPkg = {
      manifest: gadgetManifestFixture(),
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri: `sha384-${bundleSha}`,
      signatureUrl: 'https://cdn.example/bundle.js.sig',
      authorPublicKey: bytesToBase64(wrongKey),
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js',
        response: bytesResponse(200, bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js.sig',
        response: jsonResponse(200, signature),
      },
    ]);

    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );

    expect(code).toBe(1);
    expect(io.stderr.join('')).toMatch(/publicKeyId mismatch/);
  });

  it('blueprint without contract — verified + skipped materialization (warn, no disk write)', async () => {
    const blueprintManifest = blueprintManifestFixture();
    const canonicalBlueprintBytes = new TextEncoder().encode(
      canonicalJson(blueprintManifest),
    );
    const digest = sha384(canonicalBlueprintBytes);
    const signature = {
      algorithm: 'ed25519' as const,
      bundleSha384: bytesToBase64(digest),
      signature: bytesToBase64(new Uint8Array(64)),
      publicKeyId: 'fake-key-id',
      signedAt: '2026-05-17T00:00:00Z',
    };
    const readPkg = {
      manifest: blueprintManifest,
      signatureUrl: 'https://cdn.example/blueprint.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };

    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/login-form/1.0.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/blueprint.sig',
        response: jsonResponse(200, signature),
      },
    ]);

    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ kind: 'blueprint', artifactId: '@my-org/login-form', version: '1.0.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );

    expect(code).toBe(0);
    expect(io.stderr.join('')).toMatch(/no `contract` field/);
    // No materialization → no `.ggui/installed-blueprints/` directory.
    expect(existsSync(join(workDir, '.ggui', 'installed-blueprints'))).toBe(false);
  });

  it('blueprint with contract — materializes index.tsx + ggui.ui.json + appends include glob', async () => {
    const contractShape = {
      propsSpec: {
        properties: {
          city: { schema: { type: 'string' }, required: true },
        },
      },
    };
    const blueprintManifest = blueprintManifestFixture({
      contract: contractShape,
      description: 'A login form blueprint.',
    });
    const canonicalBlueprintBytes = new TextEncoder().encode(
      canonicalJson(blueprintManifest),
    );
    const digest = sha384(canonicalBlueprintBytes);
    const signature = {
      algorithm: 'ed25519' as const,
      bundleSha384: bytesToBase64(digest),
      signature: bytesToBase64(new Uint8Array(64)),
      publicKeyId: 'fake-key-id',
      signedAt: '2026-05-17T00:00:00Z',
    };
    const readPkg = {
      manifest: blueprintManifest,
      signatureUrl: 'https://cdn.example/blueprint.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/login-form/1.0.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/blueprint.sig',
        response: jsonResponse(200, signature),
      },
    ]);

    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ kind: 'blueprint', artifactId: '@my-org/login-form', version: '1.0.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );

    expect(code).toBe(0);
    const dir = join(workDir, '.ggui/installed-blueprints/my-org__login-form__1.0.0');
    expect(existsSync(join(dir, 'index.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'ggui.ui.json'))).toBe(true);

    const sourceOnDisk = readFileSync(join(dir, 'index.tsx'), 'utf-8');
    expect(sourceOnDisk).toContain('export default function');

    const uiManifest = JSON.parse(
      readFileSync(join(dir, 'ggui.ui.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(uiManifest['id']).toBe('my-org:login-form:1.0.0');
    expect(uiManifest['name']).toBe('@my-org/login-form');
    // Slice 5 follow-up (2026-05-18, H3): `entryPoint` is intentionally
    // omitted. dev-stack's `resolveEntryFile` fallback resolves
    // `index.tsx` relative to manifestDir, which is the correct
    // semantics for installed blueprints. A previous version wrote
    // `entryPoint: 'index.tsx'` which `compileUiOnDemand` resolved
    // against projectRoot — breaking every install at the bridge
    // compile-time. Pin the absence.
    expect(uiManifest['entryPoint']).toBeUndefined();
    expect(uiManifest['contract']).toEqual(contractShape);

    // Glob auto-appended to ggui.json#blueprints.include.
    const gguiOnDisk = JSON.parse(
      readFileSync(join(workDir, 'ggui.json'), 'utf-8'),
    ) as { blueprints: { include: string[] } };
    expect(gguiOnDisk.blueprints.include).toContain(
      '.ggui/installed-blueprints/**/ggui.ui.json',
    );
  });

  it('blueprint re-install same version — refuses with "already installed"', async () => {
    const contractShape = {
      propsSpec: { properties: { city: { schema: { type: 'string' } } } },
    };
    const blueprintManifest = blueprintManifestFixture({ contract: contractShape });
    const canonicalBlueprintBytes = new TextEncoder().encode(
      canonicalJson(blueprintManifest),
    );
    const digest = sha384(canonicalBlueprintBytes);
    const signature = {
      algorithm: 'ed25519' as const,
      bundleSha384: bytesToBase64(digest),
      signature: bytesToBase64(new Uint8Array(64)),
      publicKeyId: 'fake-key-id',
      signedAt: '2026-05-17T00:00:00Z',
    };
    const readPkg = {
      manifest: blueprintManifest,
      signatureUrl: 'https://cdn.example/blueprint.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    // Fetch stub built per-call — Response bodies are single-shot, so
    // re-using the same stub across two install calls produces
    // "Body is unusable" errors. Build fresh Responses each time.
    const buildStub = (): typeof fetch =>
      makeFetchStub([
        {
          matches: (url) => url.endsWith('/pkg/my-org/login-form/1.0.0'),
          response: jsonResponse(200, readPkg),
        },
        {
          matches: (url) => url === 'https://cdn.example/blueprint.sig',
          response: jsonResponse(200, signature),
        },
      ]);
    const flags = (io: ReturnType<typeof captureIO>) =>
      io.flags({ kind: 'blueprint', artifactId: '@my-org/login-form', version: '1.0.0' });

    // First install succeeds.
    const io1 = captureIO();
    const first = await runArtifactInstall(flags(io1), {
      cwd: workDir,
      env: {},
      fetch: buildStub(),
      stdout: (s) => io1.stdout.push(s),
      stderr: (s) => io1.stderr.push(s),
    });
    expect(first).toBe(0);

    // Second install refuses (the directory now exists).
    const io2 = captureIO();
    const second = await runArtifactInstall(flags(io2), {
      cwd: workDir,
      env: {},
      fetch: buildStub(),
      stdout: (s) => io2.stdout.push(s),
      stderr: (s) => io2.stderr.push(s),
    });
    expect(second).toBe(1);
    expect(io2.stderr.join('')).toMatch(/already installed/);
  });

  it('404 → exit 1, "not found" message', async () => {
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/missing/0.0.0'),
        response: jsonResponse(404, {
          error: 'not_found',
          message: 'package not found',
        }),
      },
    ]);
    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/missing', version: '0.0.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(code).toBe(1);
    expect(io.stderr.join('')).toMatch(/not found/);
  });

  it('410 yanked → exit 1, "yanked" message', async () => {
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/old/9.9.9'),
        response: jsonResponse(410, {
          manifest: gadgetManifestFixture(),
          publishedAt: '2026-05-17T00:00:00Z',
          publishedBy: 'cognito-sub-xyz',
        }),
      },
    ]);
    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/old', version: '9.9.9' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(code).toBe(1);
    expect(io.stderr.join('')).toMatch(/yanked/i);
  });

  it('403 private → exit 1 with JWT-deferred hint', async () => {
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/private/1.0.0'),
        response: jsonResponse(403, {
          error: 'forbidden',
          message: 'private package requires authentication',
        }),
      },
    ]);
    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/private', version: '1.0.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(code).toBe(1);
    expect(io.stderr.join('')).toMatch(/private/i);
  });

  it('manifest invalid → exit 1, zod issues surface in message', async () => {
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/bad/1.0.0'),
        response: jsonResponse(200, {
          manifest: { kind: 'gadget' /* missing required fields */ },
          bundleUrl: 'https://cdn.example/bundle.js',
          publishedAt: '2026-05-17T00:00:00Z',
          publishedBy: 'cognito-sub-xyz',
        }),
      },
    ]);
    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/bad', version: '1.0.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(code).toBe(1);
    expect(io.stderr.join('')).toMatch(/schema validation/);
  });

  it('SRI mismatch → exit 1', async () => {
    const { bundleBytes } = buildArtifacts('original content');
    const readPkg = {
      manifest: gadgetManifestFixture(),
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri: 'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // bogus
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js',
        response: bytesResponse(200, bundleBytes),
      },
    ]);
    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(code).toBe(1);
    expect(io.stderr.join('')).toMatch(/SRI mismatch/);
  });

  it('signature bundleSha384 mismatch → exit 1', async () => {
    const { bundleBytes, bundleSri, signature } = buildArtifacts('genuine bundle');
    // Tamper with the signature's claimed hash.
    const tampered = { ...signature, bundleSha384: 'AAAAAAAAAAAAAAAA' };
    const readPkg = {
      manifest: gadgetManifestFixture(),
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri,
      signatureUrl: 'https://cdn.example/bundle.js.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js',
        response: bytesResponse(200, bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js.sig',
        response: jsonResponse(200, tampered),
      },
    ]);
    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(code).toBe(1);
    expect(io.stderr.join('')).toMatch(/bundleSha384 mismatch/);
  });

  it('--strict + signature-skipped → exit 1', async () => {
    const { bundleBytes, bundleSri, signature } = buildArtifacts('genuine bundle');
    const readPkg = {
      manifest: gadgetManifestFixture(),
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri,
      signatureUrl: 'https://cdn.example/bundle.js.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js',
        response: bytesResponse(200, bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js.sig',
        response: jsonResponse(200, signature),
      },
    ]);
    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({
        artifactId: '@my-org/weather-card',
        version: '0.1.0',
        strict: true,
      }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(code).toBe(1);
    expect(io.stderr.join('')).toMatch(/--strict/);
  });

  it('--no-prompt + missing public-env key → warning + exit 0', async () => {
    const { bundleBytes, bundleSri, signature } = buildArtifacts('demo');
    const readPkg = {
      manifest: gadgetManifestFixture({
        requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN'],
      }),
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri,
      signatureUrl: 'https://cdn.example/bundle.js.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js',
        response: bytesResponse(200, bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js.sig',
        response: jsonResponse(200, signature),
      },
    ]);
    const io = captureIO();
    const code = await runArtifactInstall(
      io.flags({
        artifactId: '@my-org/weather-card',
        version: '0.1.0',
        noPrompt: true,
      }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(code).toBe(0);
    expect(io.stderr.join('')).toMatch(/GGUI_PUBLIC_APP_MAPBOX_TOKEN/);
    // Should still install the entry even with missing publicEnv.
    const written = JSON.parse(
      readFileSync(join(workDir, 'ggui.json'), 'utf-8'),
    ) as { app: { gadgets: Array<Record<string, unknown>> } };
    expect(written.app.gadgets).toHaveLength(1);
  });

  it('prompt path: prompter supplies value → publicEnv written', async () => {
    const { bundleBytes, bundleSri, signature } = buildArtifacts('demo');
    const readPkg = {
      manifest: gadgetManifestFixture({
        requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN'],
      }),
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri,
      signatureUrl: 'https://cdn.example/bundle.js.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js',
        response: bytesResponse(200, bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js.sig',
        response: jsonResponse(200, signature),
      },
    ]);
    const promptForEnv = vi
      .fn<(k: string) => Promise<string | null>>()
      .mockResolvedValue('pk.fake-mapbox-token');
    const io = captureIO();
    const code = await runArtifactInstall(
      {
        kind: 'gadget',
        artifactId: '@my-org/weather-card',
        version: '0.1.0',
        registry: 'https://r.example.com',
        noPrompt: false,
        strict: false,
      },
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
        promptForEnv,
      },
    );
    expect(code).toBe(0);
    expect(promptForEnv).toHaveBeenCalledWith('GGUI_PUBLIC_APP_MAPBOX_TOKEN');
    const written = JSON.parse(
      readFileSync(join(workDir, 'ggui.json'), 'utf-8'),
    ) as { app: { publicEnv?: Record<string, string> } };
    expect(written.app.publicEnv).toEqual({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.fake-mapbox-token',
    });
  });

  it('registry resolution: --registry flag beats env + ggui.json', async () => {
    // Seed both ggui.json#registry AND env so we can prove --registry wins.
    writeFileSync(
      join(workDir, 'ggui.json'),
      JSON.stringify({
        schema: '1',
        app: { slug: 'demo', name: 'Demo' },
        registry: 'https://from-config.example.com',
      }),
    );
    let observedHost: string | undefined;
    const fetchStub = makeFetchStub([
      {
        matches: (url) => {
          observedHost = new URL(url).host;
          return url.endsWith('/pkg/my-org/weather-card/0.1.0');
        },
        response: jsonResponse(404, { error: 'not_found', message: 'nope' }),
      },
    ]);
    const io = captureIO();
    await runArtifactInstall(
      {
        kind: 'gadget',
        artifactId: '@my-org/weather-card',
        version: '0.1.0',
        registry: 'https://from-flag.example.com',
        noPrompt: true,
        strict: false,
      },
      {
        cwd: workDir,
        env: { GGUI_REGISTRY: 'https://from-env.example.com' },
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(observedHost).toBe('from-flag.example.com');
  });

  it('registry resolution: ggui.json#registry beats env', async () => {
    writeFileSync(
      join(workDir, 'ggui.json'),
      JSON.stringify({
        schema: '1',
        app: { slug: 'demo', name: 'Demo' },
        registry: 'https://from-config.example.com',
      }),
    );
    let observedHost: string | undefined;
    const fetchStub = makeFetchStub([
      {
        matches: (url) => {
          observedHost = new URL(url).host;
          return true;
        },
        response: jsonResponse(404, { error: 'not_found', message: 'nope' }),
      },
    ]);
    const io = captureIO();
    await runArtifactInstall(
      {
        kind: 'gadget',
        artifactId: '@my-org/foo',
        version: '0.1.0',
        noPrompt: true,
        strict: false,
      },
      {
        cwd: workDir,
        env: { GGUI_REGISTRY: 'https://from-env.example.com' },
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(observedHost).toBe('from-config.example.com');
  });

  it('registry resolution: env beats default when no flag/config', async () => {
    // No `registry` field in ggui.json.
    let observedHost: string | undefined;
    const fetchStub = makeFetchStub([
      {
        matches: (url) => {
          observedHost = new URL(url).host;
          return true;
        },
        response: jsonResponse(404, { error: 'not_found', message: 'nope' }),
      },
    ]);
    const io = captureIO();
    await runArtifactInstall(
      {
        kind: 'gadget',
        artifactId: '@my-org/foo',
        version: '0.1.0',
        noPrompt: true,
        strict: false,
      },
      {
        cwd: workDir,
        env: { GGUI_REGISTRY: 'https://from-env.example.com' },
        fetch: fetchStub,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(observedHost).toBe('from-env.example.com');
  });

  it('no ggui.json found → exit 2', async () => {
    // Use a temp dir WITHOUT any ggui.json.
    const empty = mkdtempSync(join(tmpdir(), 'ggui-install-empty-'));
    try {
      const io = captureIO();
      const code = await runArtifactInstall(
        {
          kind: 'gadget',
          artifactId: '@my-org/foo',
          version: '0.1.0',
          registry: 'https://r.example.com',
          noPrompt: true,
          strict: false,
        },
        {
          cwd: empty,
          env: {},
          fetch: makeFetchStub([]),
          stdout: (s) => io.stdout.push(s),
          stderr: (s) => io.stderr.push(s),
        },
      );
      expect(code).toBe(2);
      expect(io.stderr.join('')).toMatch(/no ggui\.json/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('idempotent: re-installing the same package version replaces the existing entry', async () => {
    const { bundleBytes, bundleSri, signature } = buildArtifacts('v1');
    const readPkg = {
      manifest: gadgetManifestFixture({ version: '0.1.0' }),
      bundleUrl: 'https://cdn.example/bundle.js',
      bundleSri,
      signatureUrl: 'https://cdn.example/bundle.js.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub1 = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js',
        response: bytesResponse(200, bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle.js.sig',
        response: jsonResponse(200, signature),
      },
    ]);
    const io = captureIO();
    await runArtifactInstall(
      io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub1,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );

    // Second install of the SAME package version — `appendGadget`
    // dedups on the `(package, version)` identity tuple, so the row is
    // replaced rather than duplicated even with a fresh bundle URL.
    const v2 = buildArtifacts('v2');
    const readPkg2 = {
      manifest: gadgetManifestFixture({ version: '0.1.0' }),
      bundleUrl: 'https://cdn.example/bundle-v2.js',
      bundleSri: v2.bundleSri,
      signatureUrl: 'https://cdn.example/bundle-v2.js.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStub2 = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkg2),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle-v2.js',
        response: bytesResponse(200, v2.bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle-v2.js.sig',
        response: jsonResponse(200, v2.signature),
      },
    ]);
    await runArtifactInstall(
      io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStub2,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );

    const written = JSON.parse(
      readFileSync(join(workDir, 'ggui.json'), 'utf-8'),
    ) as { app: { gadgets: Array<Record<string, unknown>> } };
    expect(written.app.gadgets).toHaveLength(1);
    expect(written.app.gadgets[0]).toMatchObject({
      package: '@my-org/weather-card',
      version: '0.1.0',
      bundleUrl: 'https://cdn.example/bundle-v2.js',
      exports: [expect.objectContaining({ hook: 'useWeatherCard' })],
    });
  });

  it('distinct versions: installing v0.1.0 then v0.2.0 of the same package keeps both rows', async () => {
    // `appendGadget` dedups on the FULL `(package, version)` identity
    // tuple — a different version is a different row. Installing two
    // versions of the same package therefore yields TWO catalog
    // entries (not a replace).
    const v1 = buildArtifacts('v0.1.0 bundle');
    const readPkgV1 = {
      manifest: gadgetManifestFixture({ version: '0.1.0' }),
      bundleUrl: 'https://cdn.example/bundle-0.1.0.js',
      bundleSri: v1.bundleSri,
      signatureUrl: 'https://cdn.example/bundle-0.1.0.js.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStubV1 = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
        response: jsonResponse(200, readPkgV1),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle-0.1.0.js',
        response: bytesResponse(200, v1.bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle-0.1.0.js.sig',
        response: jsonResponse(200, v1.signature),
      },
    ]);
    const io = captureIO();
    const codeV1 = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStubV1,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(codeV1).toBe(0);

    // Install v0.2.0 of the SAME package.
    const v2 = buildArtifacts('v0.2.0 bundle');
    const readPkgV2 = {
      manifest: gadgetManifestFixture({ version: '0.2.0' }),
      bundleUrl: 'https://cdn.example/bundle-0.2.0.js',
      bundleSri: v2.bundleSri,
      signatureUrl: 'https://cdn.example/bundle-0.2.0.js.sig',
      publishedAt: '2026-05-17T00:00:00Z',
      publishedBy: 'cognito-sub-xyz',
    };
    const fetchStubV2 = makeFetchStub([
      {
        matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.2.0'),
        response: jsonResponse(200, readPkgV2),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle-0.2.0.js',
        response: bytesResponse(200, v2.bundleBytes),
      },
      {
        matches: (url) => url === 'https://cdn.example/bundle-0.2.0.js.sig',
        response: jsonResponse(200, v2.signature),
      },
    ]);
    const codeV2 = await runArtifactInstall(
      io.flags({ artifactId: '@my-org/weather-card', version: '0.2.0' }),
      {
        cwd: workDir,
        env: {},
        fetch: fetchStubV2,
        stdout: (s) => io.stdout.push(s),
        stderr: (s) => io.stderr.push(s),
      },
    );
    expect(codeV2).toBe(0);

    const written = JSON.parse(
      readFileSync(join(workDir, 'ggui.json'), 'utf-8'),
    ) as { app: { gadgets: Array<Record<string, unknown>> } };
    // TWO distinct rows — one per version.
    expect(written.app.gadgets).toHaveLength(2);
    const versions = written.app.gadgets
      .map((g) => g['version'])
      .sort();
    expect(versions).toEqual(['0.1.0', '0.2.0']);
  });

  // ── Bucket B'' B''.5 — sigstore signature branch ──────────────────
  //
  // The real verify lives in `@ggui-ai/gadget-signing` (mocked at the
  // top of this file). These tests pin the install-side dispatch:
  //   (a) valid sigstore signature → exit 0, ggui.json updated.
  //   (b) invalid sigstore signature → exit 1 with reason surfaced.
  //   (c) `--verify-identity <subject>` propagates as a literal subject.
  //   (d) `--verify-identity /pattern/` propagates as a RegExp.
  describe('sigstore signature branch (Bucket B\'\' B\'\'.5)', () => {
    /** Build a `(sigstore-signed bundle, /pkg response, fetch stub)` triple. */
    function buildSigstoreArtifacts(bundleText: string): {
      bundleBytes: Uint8Array;
      bundleSri: string;
      signature: SigstoreSignature;
      readPkg: Record<string, unknown>;
      fetchStub: typeof fetch;
    } {
      const bundleBytes = new TextEncoder().encode(bundleText);
      const digest = sha384(bundleBytes);
      const bundleSha384 = bytesToBase64(digest);
      const bundleSri = `sha384-${bundleSha384}`;
      const signature: SigstoreSignature = {
        algorithm: 'sigstore-cosign',
        bundleSha384,
        bundle: JSON.stringify({
          mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3',
          verificationMaterial: {
            x509CertificateChain: {
              certificates: [{ rawBytes: 'AAAAfulcio-leaf-cert' }],
            },
          },
          messageSignature: {
            messageDigest: { algorithm: 'SHA2_256', digest: 'AAAA' },
            signature: 'BBBB',
          },
        }),
        signedAt: '2026-05-18T00:00:00.000Z',
      };
      const readPkg = {
        manifest: gadgetManifestFixture(),
        bundleUrl: 'https://cdn.example/bundle.js',
        bundleSri,
        signatureUrl: 'https://cdn.example/bundle.js.sig',
        // Sigstore branch: server-pinned authorPublicKey is the leaf
        // cert PEM, not an Ed25519 key. Install doesn't consult it on
        // the sigstore path; we include it for round-trip realism.
        authorPublicKey: 'AAAAfulcio-leaf-cert',
        publishedAt: '2026-05-18T00:00:00.000Z',
        publishedBy: 'cognito-sub-pub',
      };
      const fetchStub = makeFetchStub([
        {
          matches: (url) => url.endsWith('/pkg/my-org/weather-card/0.1.0'),
          response: jsonResponse(200, readPkg),
        },
        {
          matches: (url) => url === 'https://cdn.example/bundle.js',
          response: bytesResponse(200, bundleBytes),
        },
        {
          matches: (url) => url === 'https://cdn.example/bundle.js.sig',
          response: jsonResponse(200, signature),
        },
      ]);
      return { bundleBytes, bundleSri, signature, readPkg, fetchStub };
    }

    beforeEach(() => {
      sigstoreMocks.verifyBundleSigstore.mockReset();
    });

    it('valid sigstore signature → exit 0, ggui.json written', async () => {
      sigstoreMocks.verifyBundleSigstore.mockResolvedValue({ valid: true });
      const { fetchStub } = buildSigstoreArtifacts('export const useFoo = () => null;');
      const io = captureIO();
      const code = await runArtifactInstall(
        io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
        {
          cwd: workDir,
          env: {},
          fetch: fetchStub,
          stdout: (s) => io.stdout.push(s),
          stderr: (s) => io.stderr.push(s),
        },
      );
      expect(code).toBe(0);
      expect(io.stdout.join('')).toContain('sigstore ok');
      expect(sigstoreMocks.verifyBundleSigstore).toHaveBeenCalledTimes(1);
      // No `expectedIdentity` propagated when `--verify-identity` unset.
      const callArg = sigstoreMocks.verifyBundleSigstore.mock.calls[0]?.[0] as {
        expectedIdentity?: unknown;
      };
      expect(callArg.expectedIdentity).toBeUndefined();
      const written = JSON.parse(
        readFileSync(join(workDir, 'ggui.json'), 'utf-8'),
      ) as { app: { gadgets: Array<Record<string, unknown>> } };
      expect(written.app.gadgets).toHaveLength(1);
    });

    it('invalid sigstore signature → exit 1, reason surfaced, no ggui.json mutation', async () => {
      sigstoreMocks.verifyBundleSigstore.mockResolvedValue({
        valid: false,
        reason: 'simulated upstream verify failure',
      });
      const { fetchStub } = buildSigstoreArtifacts('export const useFoo = () => null;');
      const io = captureIO();
      const code = await runArtifactInstall(
        io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
        {
          cwd: workDir,
          env: {},
          fetch: fetchStub,
          stdout: (s) => io.stdout.push(s),
          stderr: (s) => io.stderr.push(s),
        },
      );
      expect(code).toBe(1);
      expect(io.stderr.join('')).toContain('sigstore verify failed');
      expect(io.stderr.join('')).toContain('simulated upstream verify failure');
      // ggui.json untouched (still seed shape — no `gadgets` array).
      const written = JSON.parse(
        readFileSync(join(workDir, 'ggui.json'), 'utf-8'),
      ) as { app: { gadgets?: unknown } };
      expect(written.app.gadgets).toBeUndefined();
    });

    it('--verify-identity <literal> → propagates as literal subject string', async () => {
      sigstoreMocks.verifyBundleSigstore.mockResolvedValue({ valid: true });
      const { fetchStub } = buildSigstoreArtifacts('export const useFoo = () => null;');
      const io = captureIO();
      const code = await runArtifactInstall(
        {
          ...io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
          verifyIdentity: 'alice@example.com',
        },
        {
          cwd: workDir,
          env: {},
          fetch: fetchStub,
          stdout: (s) => io.stdout.push(s),
          stderr: (s) => io.stderr.push(s),
        },
      );
      expect(code).toBe(0);
      const callArg = sigstoreMocks.verifyBundleSigstore.mock.calls[0]?.[0] as {
        expectedIdentity?: { subject: string | RegExp };
      };
      expect(callArg.expectedIdentity).toEqual({ subject: 'alice@example.com' });
    });

    it('--verify-identity /regex/ → propagates as RegExp', async () => {
      sigstoreMocks.verifyBundleSigstore.mockResolvedValue({ valid: true });
      const { fetchStub } = buildSigstoreArtifacts('export const useFoo = () => null;');
      const io = captureIO();
      const code = await runArtifactInstall(
        {
          ...io.flags({ artifactId: '@my-org/weather-card', version: '0.1.0' }),
          verifyIdentity: '/^.+@example\\.com$/',
        },
        {
          cwd: workDir,
          env: {},
          fetch: fetchStub,
          stdout: (s) => io.stdout.push(s),
          stderr: (s) => io.stderr.push(s),
        },
      );
      expect(code).toBe(0);
      const callArg = sigstoreMocks.verifyBundleSigstore.mock.calls[0]?.[0] as {
        expectedIdentity?: { subject: string | RegExp };
      };
      expect(callArg.expectedIdentity).toBeDefined();
      const subj = callArg.expectedIdentity?.subject;
      expect(subj instanceof RegExp).toBe(true);
      if (subj instanceof RegExp) {
        expect(subj.test('alice@example.com')).toBe(true);
        expect(subj.test('eve@evil.com')).toBe(false);
      }
    });
  });
});
