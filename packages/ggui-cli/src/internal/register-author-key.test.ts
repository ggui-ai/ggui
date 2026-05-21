/**
 * `ggui keys register` unit tests — Slice 6.4-followup audit L6
 * (2026-05-19). Two surfaces:
 *
 *   1. `parseRegisterFlags` (from `../auth-keys.ts`) — pure flag parser.
 *   2. `runRegisterAuthorKey` — full orchestrator with filesystem +
 *      HTTP IO, exercised against:
 *        - registry URL resolution failure
 *        - missing keypair on disk
 *        - happy 201 (first-write) + 200 (idempotent re-register)
 *        - 401 unauthorized / 400 invalid_request / 409 key_conflict
 *          status branches (audit L2 mapping)
 *        - body's `error` discriminator preferred over status mapping
 *        - 500-class status → `http-error` fallthrough
 *        - network error (fetch throws)
 *        - malformed JSON body
 *        - 2xx with malformed body (missing subject/keyId)
 *
 * Each `runRegisterAuthorKey` test pins its own temp `~/.ggui` via
 * `GGUI_CONFIG_DIR` so the operator's real keypair + token caches are
 * never touched. The hosted-auth path is short-circuited by pre-seeding
 * the registry-token cache with a fresh document — `acquireHostedAuthJwt`
 * returns the cached token without ever touching Cognito.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRegisterFlags } from '../auth-keys.js';
import { saveRegistryToken } from './auth-cache.js';
import { writePrivateKey } from './key-store.js';
import {
  runRegisterAuthorKey,
  type RegisterKeyOutcome,
} from './register-author-key.js';

// ---------------------------------------------------------------------------
// parseRegisterFlags
// ---------------------------------------------------------------------------

describe('parseRegisterFlags', () => {
  it('parses --scope @a (space form)', () => {
    const r = parseRegisterFlags(['--scope', '@a']);
    expect(r.error).toBeUndefined();
    expect(r.scope).toBe('@a');
    expect(r.registry).toBeUndefined();
    expect(r.help).toBe(false);
  });

  it('parses --scope=@a (=value form)', () => {
    const r = parseRegisterFlags(['--scope=@a']);
    expect(r.error).toBeUndefined();
    expect(r.scope).toBe('@a');
  });

  it('parses --registry <url>', () => {
    const r = parseRegisterFlags(['--scope', '@a', '--registry', 'https://r.example']);
    expect(r.error).toBeUndefined();
    expect(r.registry).toBe('https://r.example');
  });

  it('parses --registry=<url>', () => {
    const r = parseRegisterFlags(['--scope=@a', '--registry=https://r.example']);
    expect(r.error).toBeUndefined();
    expect(r.registry).toBe('https://r.example');
  });

  it('sets help on --help', () => {
    const r = parseRegisterFlags(['--help']);
    expect(r.help).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('sets help on -h', () => {
    const r = parseRegisterFlags(['-h']);
    expect(r.help).toBe(true);
  });

  it('errors on --scope with no value', () => {
    const r = parseRegisterFlags(['--scope']);
    expect(r.error).toBe('--scope requires a value (e.g. `@my-scope`)');
  });

  it('errors on --registry with no value', () => {
    const r = parseRegisterFlags(['--scope', '@a', '--registry']);
    expect(r.error).toBe('--registry requires a URL');
  });

  it('errors on an unknown flag', () => {
    const r = parseRegisterFlags(['--bogus']);
    expect(r.error).toBe('unknown flag: --bogus');
  });

  // NB: the runtime guard in `runKeysRegister` enforces `--scope` is
  // required + starts with `@`. The parser itself is intentionally
  // permissive on those concerns — its job is just structural parsing.
  // We assert that here so a refactor doesn't accidentally move
  // semantic validation into the parser.
  it('does not enforce --scope-required at the parser layer', () => {
    const r = parseRegisterFlags([]);
    expect(r.error).toBeUndefined();
    expect(r.scope).toBeUndefined();
  });

  it('does not enforce scope-starts-with-@ at the parser layer', () => {
    const r = parseRegisterFlags(['--scope', 'no-at-sign']);
    expect(r.error).toBeUndefined();
    expect(r.scope).toBe('no-at-sign');
  });
});

// ---------------------------------------------------------------------------
// runRegisterAuthorKey
// ---------------------------------------------------------------------------

interface TestEnv {
  readonly homeDir: string;
  readonly repoDir: string;
}

function setupTestEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), 'ggui-register-'));
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
  rmSync(env.homeDir, { recursive: true, force: true });
  rmSync(env.repoDir, { recursive: true, force: true });
}

const REGISTRY_URL = 'https://r.example';

/** Pre-seed a fresh token cache so acquireHostedAuthJwt short-circuits. */
function seedFreshToken(): void {
  saveRegistryToken({
    version: 1,
    registry: REGISTRY_URL,
    idToken: 'id-token-abc',
    accessToken: 'access-token-xyz',
    refreshToken: 'refresh-token-123',
    // 2 hours in the future from the test's now() = 1_700_000_000s
    expiresAt: 1_700_000_000 + 7200,
    username: 'tester',
    writtenAt: '2026-05-19T00:00:00.000Z',
  });
}

/** Write a valid 32-byte Ed25519 keypair to the temp keystore. */
function seedKeypair(scope: string): void {
  // Raw bytes — content doesn't matter for the orchestrator (the
  // signature isn't computed in this flow; we just send the public-
  // key bytes base64-encoded).
  const priv = new Uint8Array(32).fill(0xaa);
  const pub = new Uint8Array(32).fill(0xbb);
  writePrivateKey(scope, priv, pub);
}

/**
 * Build a `typeof fetch`-compatible stub whose return shape lines up
 * with the production fetch signature. The orchestrator calls fetch
 * exactly once per run with a string URL + RequestInit, so the stub
 * narrows on those args without needing the full overload set.
 *
 * Tracker pattern: separate the spy (an explicit `vi.fn`) from the
 * fetch wrapper that delegates to it. Tests can assert on the spy's
 * `.mock.calls` after the run.
 */
interface FetchStub {
  readonly fetch: typeof fetch;
  readonly spy: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Response>>;
}

function makeFetchStub(handler: (url: string, init: RequestInit) => Response): FetchStub {
  const spy = vi.fn(handler);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return spy(url, init ?? {});
  };
  return { fetch: fetchImpl, spy };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('runRegisterAuthorKey', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    teardownTestEnv(env);
  });

  it('returns `no-registry` when no registry is resolvable', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const fetchStub = makeFetchStub(() => {
      throw new Error('unexpected fetch');
    });
    const outcome = await runRegisterAuthorKey(
      { scope: '@a' },
      {
        cwd: env.repoDir,
        env: {}, // no GGUI_REGISTRY
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('no-registry');
      expect(outcome.message).toContain('no registry configured');
    }
    expect(fetchStub.spy).not.toHaveBeenCalled();
  });

  it('returns `no-keypair` when no keypair is on disk', async () => {
    seedFreshToken();
    const fetchStub = makeFetchStub(() => {
      throw new Error('unexpected fetch');
    });
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('no-keypair');
      expect(outcome.message).toContain('no keypair found for scope @a');
    }
    expect(fetchStub.spy).not.toHaveBeenCalled();
  });

  it('returns ok with status 201 on first-write', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const fetchStub = makeFetchStub((url) => {
      expect(url).toBe(`${REGISTRY_URL}/author-keys`);
      return jsonResponse(201, {
        subject: 'cog-sub-abc',
        keyId: 'derivedKeyId',
        publicKeyBase64: 'irrelevant',
      });
    });
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.status).toBe(201);
      expect(outcome.subject).toBe('cog-sub-abc');
      expect(outcome.keyId).toBe('derivedKeyId');
      expect(outcome.registryUrl).toBe(REGISTRY_URL);
    }
    // Verify the request body carries the public-key base64 (32 bytes
    // of 0xbb encoded).
    expect(fetchStub.spy).toHaveBeenCalledTimes(1);
    const call = fetchStub.spy.mock.calls[0]!;
    const init = call[1];
    expect(init.method).toBe('POST');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({
      publicKeyBase64: Buffer.from(new Uint8Array(32).fill(0xbb)).toString('base64'),
    });
  });

  it('returns ok with status 200 on idempotent re-register', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const fetchStub = makeFetchStub(() =>
      jsonResponse(200, {
        subject: 'cog-sub-abc',
        keyId: 'derivedKeyId',
        publicKeyBase64: 'irrelevant',
      }),
    );
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.status).toBe(200);
  });

  it('maps HTTP 401 → code `unauthorized`', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const fetchStub = makeFetchStub(() =>
      jsonResponse(401, {
        error: 'unauthorized',
        message: 'missing or invalid Cognito JWT',
      }),
    );
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    assertOutcomeError(outcome, 'unauthorized');
    if (!outcome.ok) {
      expect(outcome.message).toBe('missing or invalid Cognito JWT');
    }
  });

  it('maps HTTP 400 → code `invalid_request`', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const fetchStub = makeFetchStub(() =>
      jsonResponse(400, {
        error: 'invalid_request',
        message: '`publicKeyBase64` is required',
      }),
    );
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    assertOutcomeError(outcome, 'invalid_request');
  });

  it('maps HTTP 409 → code `key_conflict`', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const fetchStub = makeFetchStub(() =>
      jsonResponse(409, {
        error: 'key_conflict',
        message: 'collision against existing row',
      }),
    );
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    assertOutcomeError(outcome, 'key_conflict');
    if (!outcome.ok) {
      expect(outcome.message).toBe('collision against existing row');
    }
  });

  it('prefers body `error` discriminator over status-code mapping', async () => {
    seedFreshToken();
    seedKeypair('@a');
    // Server sent status 500 but a structured `key_conflict` error in
    // the body — the body wins because it's authoritative.
    const fetchStub = makeFetchStub(() =>
      jsonResponse(500, {
        error: 'key_conflict',
        message: 'this should win',
      }),
    );
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    assertOutcomeError(outcome, 'key_conflict');
  });

  it('maps body `error: server_error` to generic `http-error`', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const fetchStub = makeFetchStub(() =>
      jsonResponse(500, {
        error: 'server_error',
        message: 'failed to write AuthorKey row',
      }),
    );
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    assertOutcomeError(outcome, 'http-error');
    if (!outcome.ok) {
      expect(outcome.message).toBe('failed to write AuthorKey row');
    }
  });

  it('falls back to status-code mapping when body omits `error`', async () => {
    seedFreshToken();
    seedKeypair('@a');
    // 401 with no `error` discriminator — status mapping should kick in.
    const fetchStub = makeFetchStub(
      () =>
        new Response(JSON.stringify({ message: 'token expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    assertOutcomeError(outcome, 'unauthorized');
    if (!outcome.ok) {
      expect(outcome.message).toBe('token expired');
    }
  });

  it('maps 5xx with no structured body → `http-error`', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const fetchStub = makeFetchStub(() =>
      jsonResponse(503, { message: 'service unavailable' }),
    );
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    assertOutcomeError(outcome, 'http-error');
  });

  it('returns `network-error` when fetch throws', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const throwingFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: throwingFetch,
        now: () => 1_700_000_000,
      },
    );
    assertOutcomeError(outcome, 'network-error');
    if (!outcome.ok) {
      expect(outcome.message).toContain('ECONNREFUSED');
    }
  });

  it('returns `bad-response` when JSON parse fails', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const fetchStub = makeFetchStub(
      () =>
        new Response('this is not json', {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    assertOutcomeError(outcome, 'bad-response');
  });

  it('returns `bad-response` when 2xx body is missing subject/keyId', async () => {
    seedFreshToken();
    seedKeypair('@a');
    const fetchStub = makeFetchStub(() =>
      // Missing `keyId`.
      jsonResponse(201, { subject: 'cog-sub-abc' }),
    );
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: {},
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    assertOutcomeError(outcome, 'bad-response');
    if (!outcome.ok) {
      expect(outcome.message).toContain('missing subject/keyId');
    }
  });

  it('uses --registry flag in preference to env / ggui.json', async () => {
    seedFreshToken();
    seedKeypair('@a');
    // Write a competing ggui.json in cwd that points at a different
    // URL; the flag should still win.
    writeFileSync(
      join(env.repoDir, 'ggui.json'),
      JSON.stringify({ registry: 'https://NOT-THE-FLAG.example' }),
    );
    const fetchStub = makeFetchStub((url) => {
      expect(url.startsWith(REGISTRY_URL)).toBe(true);
      return jsonResponse(201, {
        subject: 's',
        keyId: 'k',
        publicKeyBase64: '',
      });
    });
    const outcome = await runRegisterAuthorKey(
      { scope: '@a', registry: REGISTRY_URL },
      {
        cwd: env.repoDir,
        env: { GGUI_REGISTRY: 'https://NOT-THE-ENV.example' },
        fetch: fetchStub.fetch,
        now: () => 1_700_000_000,
      },
    );
    expect(outcome.ok).toBe(true);
  });
});

/**
 * Assert that an outcome is an error of the expected code. Narrows the
 * discriminated union for the caller so subsequent assertions land in
 * the right branch without re-checking `ok`.
 */
function assertOutcomeError(
  outcome: RegisterKeyOutcome,
  expectedCode: Extract<RegisterKeyOutcome, { ok: false }>['code'],
): asserts outcome is Extract<RegisterKeyOutcome, { ok: false }> {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.code).toBe(expectedCode);
  }
}
