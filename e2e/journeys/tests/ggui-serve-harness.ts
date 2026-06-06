/**
 * Shared test helper for the `journeys-ggui-oss` Playwright project.
 *
 * Not a spec — named without the `.spec.` / `.test.` suffix so Playwright's
 * default `testMatch` skips it. Specs import from here.
 *
 * Enforces the Phase 5 clean-room invariants per
 * `docs/plans/2026-04-21-oss-split-e2e-phases.md` §4.4:
 *
 *   1. Fresh temp CWD (`mkdtempSync`) — no `ggui.json` inheritance from
 *      walking up the monorepo tree.
 *   2. Explicit env allowlist — `GGUI_*`, `ANTHROPIC_*`, `AWS_*`,
 *      `COGNITO_*`, `HTTP[S]_PROXY`, `NO_PROXY` never leak into the
 *      spawned process.
 *   3. Browser-side network gate — any `*.ggui.ai`,
 *      `*.amazonaws.com`, `*.cognito.com` request from the viewer is aborted and the
 *      attempt recorded. Specs assert `[]` at teardown.
 *
 * What this harness deliberately does NOT do (called out here so future
 * sessions don't silently regress the contract):
 *
 *   - Intercept Node-side outbound `fetch` from the spawned `ggui serve`
 *     process. Cross-process MITM is overkill for this slice. The `@ggui-ai/*`
 *     packages on the serve path do not import from any hosted-side
 *     package, which is the architectural safeguard — statically enforced
 *     by the open-source subtree split. When a cheap runtime MITM lands
 *     (e.g. `undici.setGlobalDispatcher` via a preload) this helper is the
 *     right place to wire it.
 */
import { test, type Page, type Route, type Request } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { packagePath } from './workspace-paths';

// Publishable-package paths are resolved CONTEXT-INDEPENDENTLY via
// `workspace-paths.ts` — it walks up to the nearest `pnpm-workspace.yaml`
// (which is `oss/` in the monorepo and the repo root in the OSS
// standalone repo) and roots `packages/<pkg>/` off it. A fixed
// `../../../..` would be correct in exactly one layout and silently
// wrong in the other.

/**
 * Exported so specs can print the resolved path in error messages.
 * Resolves to `<oss>/packages/ggui-cli/dist/cli.js` in the monorepo and
 * `<repo>/packages/ggui-cli/dist/cli.js` in the OSS standalone repo.
 */
export const GGUI_CLI_DIST = packagePath('ggui-cli', 'dist', 'cli.js');
export const DEVTOOL_DIST = packagePath('console', 'dist', 'index.html');

/**
 * Canonical env-var name that lets an operator explicitly opt out of
 * Lane 2 live-BYOK specs even when `ANTHROPIC_API_KEY` is present.
 * Set to `'0'` to skip — see {@link shouldSkipLane2Advisory}.
 */
export const LANE_2_OPT_OUT_VAR = 'GGUI_OSS_LIVE_BYOK';

/**
 * Canonical Lane 2 advisory-skip envelope. Returns `{skip: true,
 * reason}` when any of the four precondition gates is missing; the
 * caller invokes `test.skip(true, result.reason)` + returns from
 * `beforeAll`. See `e2e/ggui-oss/LANES.md` §"Gating discipline" for
 * the canonical 4-check order (CLI dist → console dist → opt-out
 * → BYOK key).
 *
 * Shipped 2026-04-24 to close LANES §Gaps #2 — before this every
 * Lane 2 spec duplicated the same four-check block inline, and
 * the inline copies drifted subtly (different wording per spec,
 * different error-message emphasis). Factoring here keeps the
 * gating semantics frozen in one place.
 *
 * @param specLabel Human-readable label for the final "no key"
 *   skip-reason (e.g. `'Notes proof'`, `'cache spec'`). Kept optional
 *   so callers that genuinely don't care about the label can omit it;
 *   the default reads generically.
 */
export function shouldSkipLane2Advisory(opts: { readonly specLabel?: string } = {}): {
  readonly skip: boolean;
  readonly reason?: string;
} {
  if (!existsSync(GGUI_CLI_DIST)) {
    return {
      skip: true,
      reason: `@ggui-ai/cli dist missing at ${GGUI_CLI_DIST}. Run \`pnpm --filter @ggui-ai/cli build\` first.`,
    };
  }
  if (!existsSync(DEVTOOL_DIST)) {
    return {
      skip: true,
      reason: `@ggui-ai/console dist missing at ${DEVTOOL_DIST}. Run \`pnpm --filter @ggui-ai/console build\` first.`,
    };
  }
  if (process.env[LANE_2_OPT_OUT_VAR] === '0') {
    return {
      skip: true,
      reason: `${LANE_2_OPT_OUT_VAR}=0 — Lane 2 live-BYOK spec explicitly skipped by operator.`,
    };
  }
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key || key.length === 0) {
    const label = opts.specLabel ?? 'Lane 2 spec';
    return {
      skip: true,
      reason:
        `ANTHROPIC_API_KEY not set — ${label} requires a real Anthropic key. ` +
        `Advisory lane: no key = skip, not fail.`,
    };
  }
  return { skip: false };
}

/**
 * Domains a `ggui serve` instance MUST NOT reach when running under the
 * `journeys-ggui-oss` harness. Reaching any of these would invalidate the
 * "works without any hosted infrastructure" product claim per §4.1.
 * Matched as hostname suffixes.
 */
export const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  'ggui.ai',
  'amazonaws.com',
  'cognito.com',
  // `cognito-identity.amazonaws.com` / `cognito-idp.amazonaws.com` are
  // already covered by the `amazonaws.com` suffix; the standalone entry
  // above is belt-and-suspenders for future AWS service moves.
];

/**
 * Upper bound on `ggui serve` producing its `READY` beacon. Matches the
 * existing `npx-bootstrap.spec.ts` budget so both specs share the same
 * operator expectation.
 */
export const READY_TIMEOUT_MS = 15_000;

/**
 * Compose the allowlisted environment the spawned process receives.
 *
 * Only `PATH`, `HOME`, `NODE_ENV=test`, and `FORCE_COLOR=0` (to keep
 * stdout grep-able for the `READY` beacon) are forwarded. Every other
 * ambient env var — in particular anything starting with `GGUI_` /
 * `ANTHROPIC_` / `AWS_` / `COGNITO_`, plus proxy vars — is stripped.
 *
 * `PATH` is the one necessary leak: `node` itself lives on the caller's
 * `PATH`. If we stripped that the `spawn('node', …)` would fail before
 * we could observe it. `HOME` is allowed so Node can resolve the default
 * npm cache location if any inner dynamic-import path touches it; this
 * is a harmless read.
 *
 * **BYOK carve-out.** Plan §4.4 #3 explicitly permits a spec to forward
 * a named env var "for a specific path" (e.g., a BYOK key for a live
 * generation test) provided the forwarding is explicit and commented.
 * `forwardEnv` is that hole: each name in the array is forwarded
 * verbatim from `process.env` when present, and `assertNoBannedEnv(env,
 * { skip })` below must be called with the same list so the banned-
 * prefix sweep skips them. Callers that don't need the hole pass an
 * empty list (or omit the arg) and the clean-room invariants hold
 * unchanged.
 *
 * **`codeCacheDir`.** When set, `GGUI_CODE_CACHE_DIR` is stamped into
 * the spawned env so the server's `FileSystemCodeStore` writes to a
 * per-spawn directory instead of the shared, persistent
 * `~/.ggui/code-cache`. This is NOT an ambient leak (the value is
 * harness-minted, not read from `process.env`) — it is the opposite:
 * test isolation. Without it, a generated component cached by one run
 * serves an instant cross-run hit on the next, and "real LLM call"
 * latency-floor assertions fail spuriously. Callers pass the name to
 * `assertNoBannedEnv`'s `skip` for the same reason `forwardEnv` does.
 *
 * **`embeddingCacheDir`.** Same shape as `codeCacheDir`, redirects the
 * Xenova ONNX embedding model away from the user's `~/.ggui/models/`.
 * Without it, every spawned server downloads (or competes for) the
 * default 30 MB model file, and CI runs have hit
 * `Protobuf parsing failed` when a download is interrupted (test
 * timeout / SIGTERM) or two concurrent spawns race on the same file.
 * Callers pass {@link EMBEDDING_CACHE_ENV} to `assertNoBannedEnv`'s
 * `skip` for the same reason as `codeCacheDir`.
 */
export function allowlistedEnv(
  opts: {
    readonly forwardEnv?: readonly string[];
    readonly codeCacheDir?: string;
    readonly embeddingCacheDir?: string;
  } = {},
): NodeJS.ProcessEnv {
  const src = process.env;
  const out: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    FORCE_COLOR: '0',
  };
  if (src['PATH']) out['PATH'] = src['PATH'];
  if (src['HOME']) out['HOME'] = src['HOME'];
  for (const key of opts.forwardEnv ?? []) {
    const v = src[key];
    if (typeof v === 'string' && v.length > 0) {
      out[key] = v;
    }
  }
  if (opts.codeCacheDir) {
    out['GGUI_CODE_CACHE_DIR'] = opts.codeCacheDir;
  }
  if (opts.embeddingCacheDir) {
    out['GGUI_EMBEDDING_CACHE_DIR'] = opts.embeddingCacheDir;
  }
  return out;
}

/**
 * Env var name for the per-spawn code-cache isolation directory. Passed
 * to {@link assertNoBannedEnv}'s `skip` at every call site that supplies
 * a {@link allowlistedEnv} `codeCacheDir` — the value is harness-minted
 * isolation, not an ambient `GGUI_*` leak.
 */
const CODE_CACHE_ENV = 'GGUI_CODE_CACHE_DIR';

/**
 * Env var name for the per-worker embedding-cache isolation directory.
 * Same role as {@link CODE_CACHE_ENV} — passed to
 * {@link assertNoBannedEnv}'s `skip` so the harness-minted value
 * isn't mistaken for an ambient `GGUI_*` leak.
 */
const EMBEDDING_CACHE_ENV = 'GGUI_EMBEDDING_CACHE_DIR';

/**
 * One embedding-cache dir shared across every spawn in this Playwright
 * worker. CI runs with `workers: 1` + `fullyParallel: false`, so spec
 * spawns are strictly serial — first spawn downloads the ~30 MB model
 * into this dir, every subsequent spawn reads the warmed file from disk.
 * No concurrent-download race, no per-spawn re-fetch.
 *
 * Lives under `os.tmpdir()` so the CI runner reclaims it on container
 * teardown; the harness deliberately does NOT remove it between spawns
 * (that would defeat the caching).
 */
const SHARED_EMBEDDING_CACHE_DIR = join(
  tmpdir(),
  `ggui-e2e-embeddings-${process.pid}`,
);

/** Keys that must NEVER appear in the spawned env. Used by diagnostics. */
export const BANNED_ENV_PREFIXES: readonly string[] = [
  'GGUI_',
  'ANTHROPIC_',
  'AWS_',
  'COGNITO_',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/**
 * Throw if the composed env contains anything that would invalidate the
 * clean-room claim. Defense-in-depth: `allowlistedEnv()` above is
 * allowlist-by-construction, but a future refactor could widen the
 * surface silently. This check makes such a regression loud.
 *
 * `opts.skip` — names explicitly forwarded by the caller under the
 * plan §4.4 #3 BYOK carve-out. Passing `{ skip: ['ANTHROPIC_API_KEY'] }`
 * tells the check "this specific name is expected to be present and
 * the caller owns the decision." Without it, forwarding a BYOK key
 * would trip the banned-prefix sweep and throw.
 */
export function assertNoBannedEnv(
  env: NodeJS.ProcessEnv,
  opts: { readonly skip?: readonly string[] } = {},
): void {
  const skipSet = new Set(opts.skip ?? []);
  const leaks: string[] = [];
  for (const key of Object.keys(env)) {
    if (skipSet.has(key)) continue;
    for (const prefix of BANNED_ENV_PREFIXES) {
      if (key === prefix || key.startsWith(prefix)) {
        leaks.push(key);
        break;
      }
    }
  }
  if (leaks.length > 0) {
    throw new Error(
      `clean-room invariant violated — env leak(s): ${leaks.join(', ')}`,
    );
  }
}

/** Handle returned by {@link spawnGguiServe}. Tests use it to assert + tear down. */
export interface GguiServeHandle {
  /** Base URL, e.g. `http://127.0.0.1:54321`. Populated after READY. */
  readonly baseUrl: string;
  /** Absolute path of the temporary CWD the process was spawned with. */
  readonly tempCwd: string;
  /**
   * Frozen snapshot of the env the child process was spawned with. Used
   * by {@link attachServeArtifacts} to dump evidence of the §4.4 #3
   * allowlist invariant on failure. Keys only (values redacted for
   * forwarded secrets) so a BYOK key never lands in a CI artifact
   * upload.
   */
  readonly spawnEnv: Readonly<NodeJS.ProcessEnv>;
  /**
   * Pre-minted initial pairing code parsed off the child's
   * `PAIR_CODE <code>` stdout beacon. `ggui serve` always emits one
   * today (pairing is on in the CLI composition). Consume it via
   * {@link mintPairToken} for bearer tokens. Null only when the
   * beacon never arrived within the READY window, which is a test-
   * infra bug — specs that reach for `initialPairCode` can assume
   * non-null after `spawnGguiServe` resolves.
   */
  readonly initialPairCode: string | null;
  /**
   * Admin token parsed off the child's `ADMIN_TOKEN <token>` stdout
   * beacon. Required to exchange for the `ggui_console_admin` cookie
   * via `POST /ggui/console/admin-login`, which lets the browser-side
   * SPA reach `/admin/*` and `/devtools/*` routes.
   *
   * Null when the server runs without admin gating (legacy mode) or
   * the beacon never arrived within the READY window. Specs that need
   * admin auth should call {@link signInAsAdmin} instead of touching
   * this directly — the helper handles the cookie exchange end-to-end.
   */
  readonly adminToken: string | null;
  /**
   * Browser-side admin auth helper. POSTs the captured `adminToken` to
   * `/ggui/console/admin-login`, accepts the `Set-Cookie` reply, and
   * stamps the cookie onto the page's browser context so subsequent
   * `page.goto('${baseUrl}/admin/...')` calls bypass the 302-to-login
   * redirect that operator-only routes ship with since the Slice 1
   * `/admin/*` rename + Slice 4 admin-HTML gate.
   *
   * Throws if the handle has no `adminToken` (server isn't gated, or
   * beacon was missed — both real test-infra failures, not a quiet
   * skip). Returns once the cookie is present in the context.
   */
  signInAsAdmin: (page: Page) => Promise<void>;
  /**
   * Wall-clock ms between `spawn()` and both boot beacons
   * (`READY <baseUrl>` + `PAIR_CODE <code>`) arriving. Exposed so specs
   * can record the cold-boot timing via {@link PerfRecorder} without
   * duplicating the `Date.now()` bookkeeping. See
   * `perf-recorder.ts` + `BLOCKING_BUDGETS_MS['cold-boot']`.
   */
  readonly readyElapsedMs: number;
  /** stderr the child process has produced so far — useful for failure dumps. */
  readonly stderr: () => string;
  /** stdout the child process has produced so far — useful for failure dumps. */
  readonly stdout: () => string;
  /** Kill the child + remove the temp dir. Idempotent. */
  close: () => Promise<void>;
}

/** Optional inputs to {@link spawnGguiServe}. Empty object is the same as no options. */
export interface SpawnGguiServeOptions {
  /**
   * Absolute path to a fixture directory whose contents are copied
   * into the spawned process's CWD before boot. Use this to seed a
   * `ggui.json` + supporting files (blueprints, primitive manifests,
   * `theme.json`) for the manifest-capabilities journey without
   * polluting the workspace and without losing the §4.4 #1 clean-room
   * invariant: copy semantics mean the spawned process still walks an
   * isolated `mkdtempSync` tree, just one we've seeded with files we
   * own. Mutations the server writes (sqlite stores, etc.) stay
   * confined to the temp dir and are deleted on teardown.
   *
   * Omit / `undefined` to spawn against an empty CWD (the original
   * behaviour — surfaces the zero-config first-run path).
   */
  readonly fixtureDir?: string;

  /**
   * Env var names to forward verbatim from the caller's `process.env`
   * into the spawned child. The plan §4.4 #3 BYOK carve-out — specs
   * that legitimately need a real credential (e.g., a live-generation
   * journey under a real Anthropic key) pass `['ANTHROPIC_API_KEY']` here.
   * Values absent from the caller's env are silently dropped; the
   * spec is responsible for `test.skip()`-gating on presence before
   * this harness is called.
   *
   * Clean-room specs omit this (default `[]`). Adding a name here
   * widens the clean-room surface for ONE spec only — the opt-in
   * posture keeps the default path honest.
   */
  readonly forwardEnv?: readonly string[];
}

/** Boot beacons a `ggui serve`-shaped child prints on stdout. */
interface BootBeacons {
  readonly baseUrl: string;
  readonly initialPairCode: string | null;
  readonly adminToken: string | null;
}

/**
 * Grace window for a trailing `ADMIN_TOKEN` beacon.
 *
 * The CLI writes `READY` / `PAIR_CODE` / `ADMIN_TOKEN` synchronously
 * back-to-back, but the OS can split them across stdout `data` chunks —
 * `READY`+`PAIR_CODE` in one, `ADMIN_TOKEN` in the next. Resolving the
 * instant the first two land drops the token, and `signInAsAdmin` then
 * hard-throws "beacon never parsed". So once `READY`+`PAIR_CODE` are in
 * hand we wait this long for `ADMIN_TOKEN`; if it never arrives (a
 * server genuinely running without an admin token) the grace expires
 * and the token resolves `null` — `signInAsAdmin` owns the error from
 * there. In the common case all three land in one chunk and the grace
 * never arms.
 */
const ADMIN_TOKEN_GRACE_MS = 1_000;

/** Live stdout/stderr capture + a one-shot boot-beacon promise. */
interface BeaconWatcher {
  /** Resolves with the parsed beacons, or rejects on timeout / early exit. */
  readonly beacons: Promise<BootBeacons>;
  /** All stdout the child has produced so far. */
  readonly stdout: () => string;
  /** All stderr the child has produced so far. */
  readonly stderr: () => string;
}

/**
 * Wire stdout/stderr capture + boot-beacon parsing onto a spawned
 * `ggui serve`-shaped child. Shared by all three spawn helpers so the
 * `READY` / `PAIR_CODE` / `ADMIN_TOKEN` plumbing — and the
 * {@link ADMIN_TOKEN_GRACE_MS} race fix — lives in exactly one place.
 *
 * `label` is the bare process name; stdout is echoed under `[label]`
 * and stderr under `[label:err]`. `subject` names the process in
 * timeout / premature-exit error messages.
 */
function watchBootBeacons(
  proc: ChildProcessWithoutNullStreams,
  opts: { readonly label: string; readonly subject: string },
): BeaconWatcher {
  let stdoutBuf = '';
  let stderrBuf = '';

  const beacons = new Promise<BootBeacons>((done, fail) => {
    let settled = false;
    let resolvedBaseUrl: string | null = null;
    let resolvedPairCode: string | null = null;
    let resolvedAdminToken: string | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const readyTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      fail(
        new Error(
          `${opts.subject} did not print READY + PAIR_CODE within ${READY_TIMEOUT_MS}ms — stderr so far:\n${stderrBuf}`,
        ),
      );
    }, READY_TIMEOUT_MS);

    const finish = (): void => {
      if (settled) return;
      if (resolvedBaseUrl === null || resolvedPairCode === null) return;
      settled = true;
      clearTimeout(readyTimer);
      if (graceTimer) clearTimeout(graceTimer);
      done({
        baseUrl: resolvedBaseUrl,
        initialPairCode: resolvedPairCode,
        adminToken: resolvedAdminToken,
      });
    };

    const tryFinish = (): void => {
      if (settled || resolvedBaseUrl === null || resolvedPairCode === null) {
        return;
      }
      // READY + PAIR_CODE are in — the readyTimer's "did it boot?"
      // window is satisfied; only the short ADMIN_TOKEN grace remains.
      clearTimeout(readyTimer);
      // Resolve immediately once ADMIN_TOKEN also lands; otherwise give
      // a trailing stdout chunk a bounded window before resolving with
      // a null token.
      if (resolvedAdminToken !== null) {
        finish();
      } else if (graceTimer === null) {
        graceTimer = setTimeout(finish, ADMIN_TOKEN_GRACE_MS);
      }
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      process.stdout.write(`[${opts.label}] ${chunk}`);
      stdoutBuf += chunk;
      if (resolvedBaseUrl === null) {
        const m = stdoutBuf.match(/READY\s+(https?:\/\/\S+)/);
        if (m) resolvedBaseUrl = m[1]!;
      }
      if (resolvedPairCode === null) {
        const m = stdoutBuf.match(/PAIR_CODE\s+(\d{6})/);
        if (m) resolvedPairCode = m[1]!;
      }
      if (resolvedAdminToken === null) {
        const m = stdoutBuf.match(/ADMIN_TOKEN\s+(\S+)/);
        if (m) resolvedAdminToken = m[1]!;
      }
      tryFinish();
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      process.stderr.write(`[${opts.label}:err] ${chunk}`);
      stderrBuf += chunk;
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      if (graceTimer) clearTimeout(graceTimer);
      fail(
        new Error(
          `${opts.subject} exited prematurely with code ${code ?? 'null'} — stderr:\n${stderrBuf}`,
        ),
      );
    });
  });

  return {
    beacons,
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
  };
}

/**
 * Spawn `ggui serve --port 0 --mcp-only` in a fresh temp directory with
 * only the allowlisted env. Returns once the child prints `READY <url>`
 * AND `PAIR_CODE <code>` on stdout.
 *
 * When `opts.fixtureDir` is supplied, its contents are copied into the
 * temp CWD before spawn so `ggui serve` can discover a real
 * `ggui.json` + neighbouring blueprint / primitive / theme files. The
 * spawned process still runs against an isolated tree — fixture seeding
 * does not weaken the §4.4 clean-room invariants (no walked-up
 * `ggui.json` from the monorepo, no env leakage).
 *
 * Throws if the `@ggui-ai/cli` dist is missing (the caller is expected
 * to skip via `test.skip()` in `beforeAll` if so) or the child exits
 * before READY, or the READY timeout fires.
 *
 * The child is spawned with `stdio: 'pipe'` so we can capture both
 * streams for the failure-artifact dump — spec-level failure capture
 * per §12.1 of the plan.
 */
export async function spawnGguiServe(
  opts: SpawnGguiServeOptions = {},
): Promise<GguiServeHandle> {
  if (!existsSync(GGUI_CLI_DIST)) {
    throw new Error(
      `@ggui-ai/cli dist missing at ${GGUI_CLI_DIST}. Run \`pnpm --filter @ggui-ai/cli build\` first.`,
    );
  }
  if (!existsSync(DEVTOOL_DIST)) {
    throw new Error(
      `@ggui-ai/console dist missing at ${DEVTOOL_DIST}. Run \`pnpm --filter @ggui-ai/console build\` first.`,
    );
  }

  const tempCwd = mkdtempSync(join(tmpdir(), 'ggui-pair-e2e-'));
  if (opts.fixtureDir) {
    if (!existsSync(opts.fixtureDir)) {
      throw new Error(
        `spawnGguiServe: fixtureDir does not exist: ${opts.fixtureDir}`,
      );
    }
    // `cpSync` with `recursive: true` mirrors the fixture's directory
    // tree into the temp cwd. We deliberately avoid `dereference: true`
    // — symlinks in a fixture would point at workspace files and break
    // the clean-room claim. Same reason `node_modules` should never
    // appear in a fixture: copying it would drag the workspace tree
    // along by reference.
    cpSync(opts.fixtureDir, tempCwd, { recursive: true });
  }
  const forwardEnv = opts.forwardEnv ?? [];
  // Per-spawn code cache — nested inside `tempCwd` so the existing
  // `rmSync(tempCwd)` teardown reclaims it. Without this every spawned
  // server shares the persistent `~/.ggui/code-cache` and a generated
  // component cached by a prior run serves an instant cross-run hit,
  // breaking the "real LLM call" latency-floor assertions.
  const codeCacheDir = join(tempCwd, '.ggui-code-cache');
  const env = allowlistedEnv({
    forwardEnv,
    codeCacheDir,
    embeddingCacheDir: SHARED_EMBEDDING_CACHE_DIR,
  });
  assertNoBannedEnv(env, {
    skip: [...forwardEnv, CODE_CACHE_ENV, EMBEDDING_CACHE_ENV],
  });

  // `--mcp-only` because the temp cwd has no `ggui.json` / `agent.entry`.
  // `--port 0` yields an OS-assigned port; the CLI's `pickFreePort` path
  // resolves it before binding and the `READY` line carries the result.
  // `spawnStartedAt` anchors the cold-boot elapsed exposed on the handle
  // — captured here (just before `spawn()`) so the reading includes
  // Node's process-creation cost, not just the `listen()` window.
  const spawnStartedAt = Date.now();
  const proc: ChildProcessWithoutNullStreams = spawn(
    'node',
    [GGUI_CLI_DIST, 'serve', '--port', '0', '--mcp-only'],
    {
      cwd: tempCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    },
  ) as ChildProcessWithoutNullStreams;

  const watcher = watchBootBeacons(proc, {
    label: 'ggui serve',
    subject: 'ggui serve',
  });
  const { baseUrl, initialPairCode, adminToken } = await watcher.beacons;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (!proc.killed) {
      proc.kill('SIGTERM');
      await new Promise<void>((done) => {
        const resolve2 = (): void => done();
        proc.once('exit', resolve2);
        // SIGTERM triggers the CLI's AbortController for a clean close.
        // If it wedges, escalate to SIGKILL after 5s so teardown never
        // blocks Playwright's worker-exit path.
        setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL');
          } catch {
            /* best-effort */
          }
          resolve2();
        }, 5_000);
      });
    }
    try {
      rmSync(tempCwd, { recursive: true, force: true });
    } catch {
      /* best-effort — tmp dir cleanup failures are noise, not signal */
    }
  };

  const handle: GguiServeHandle = {
    baseUrl,
    tempCwd,
    spawnEnv: freezeEnv(env),
    initialPairCode,
    adminToken,
    readyElapsedMs: Date.now() - spawnStartedAt,
    stderr: watcher.stderr,
    stdout: watcher.stdout,
    close,
    signInAsAdmin: (page) => signInAsAdmin(handle, page),
  };
  return handle;
}

/**
 * Spawn the **real** `ggui serve` CLI binary in an explicit working
 * directory (no `mkdtempSync`, no copy). Intended for fixtures that
 * need the spawned process to resolve modules from the monorepo's
 * `node_modules/` chain — e.g., the Slice 6 `ggui.json#mcpMounts`
 * fixture imports `zod` from its mount module and needs Node's
 * resolver to walk up to `e2e/ggui-oss/node_modules/`.
 *
 * Trade-off vs. {@link spawnGguiServe}: this helper relaxes the
 * §4.4 #1 "fresh temp CWD" clean-room invariant (the spawned process
 * CAN reach files above its CWD) in exchange for a real module-
 * resolution chain. It still enforces §4.4 #2 (env allowlist +
 * banned-prefix sweep) and §4.4 #3 (BYOK carve-out). Use
 * `spawnGguiServe` for zero-config / npx-bootstrap flows; use this
 * helper only when the fixture intentionally reads from the
 * workspace's resolution graph.
 *
 * Same boot-beacon contract (`READY <url>` + `PAIR_CODE <code>`) so
 * the returned handle plugs into `mintPairToken`, `mcpCallAs`,
 * `attachServeArtifacts` without branching.
 */
export interface SpawnGguiServeInCwdOptions {
  /** Absolute path to the CWD the CLI spawns in. Must exist and
   *  contain (or sit under) a `ggui.json` for manifest-driven fixtures
   *  to take effect. */
  readonly cwd: string;
  /** Env var names to forward verbatim — same carve-out semantics as
   *  {@link SpawnGguiServeOptions.forwardEnv}. */
  readonly forwardEnv?: readonly string[];
}

export async function spawnGguiServeInCwd(
  opts: SpawnGguiServeInCwdOptions,
): Promise<GguiServeHandle> {
  if (!existsSync(GGUI_CLI_DIST)) {
    throw new Error(
      `@ggui-ai/cli dist missing at ${GGUI_CLI_DIST}. Run \`pnpm --filter @ggui-ai/cli build\` first.`,
    );
  }
  if (!existsSync(DEVTOOL_DIST)) {
    throw new Error(
      `@ggui-ai/console dist missing at ${DEVTOOL_DIST}. Run \`pnpm --filter @ggui-ai/console build\` first.`,
    );
  }
  if (!existsSync(opts.cwd)) {
    throw new Error(
      `spawnGguiServeInCwd: cwd does not exist: ${opts.cwd}`,
    );
  }

  const forwardEnv = opts.forwardEnv ?? [];
  // Per-spawn code cache. `opts.cwd` is caller-owned (a fixture dir we
  // must not pollute), so the cache gets its own temp dir, reclaimed in
  // `close()`. See `spawnGguiServe` for why isolation matters.
  const codeCacheDir = mkdtempSync(join(tmpdir(), 'ggui-code-cache-e2e-'));
  const env = allowlistedEnv({
    forwardEnv,
    codeCacheDir,
    embeddingCacheDir: SHARED_EMBEDDING_CACHE_DIR,
  });
  assertNoBannedEnv(env, {
    skip: [...forwardEnv, CODE_CACHE_ENV, EMBEDDING_CACHE_ENV],
  });

  // See `spawnGguiServe` for rationale on capturing the cold-boot
  // wall-clock anchor before the `spawn()` call.
  const spawnStartedAt = Date.now();
  const proc: ChildProcessWithoutNullStreams = spawn(
    'node',
    [GGUI_CLI_DIST, 'serve', '--port', '0', '--mcp-only'],
    {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    },
  ) as ChildProcessWithoutNullStreams;

  const watcher = watchBootBeacons(proc, {
    label: 'ggui serve:cwd',
    subject: 'ggui serve',
  });
  const { baseUrl, initialPairCode, adminToken } = await watcher.beacons;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (!proc.killed) {
      proc.kill('SIGTERM');
      await new Promise<void>((done) => {
        const resolve2 = (): void => done();
        proc.once('exit', resolve2);
        setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL');
          } catch {
            /* best-effort */
          }
          resolve2();
        }, 5_000);
      });
    }
    // The caller owns `cwd`; the harness owns only the code-cache temp.
    try {
      rmSync(codeCacheDir, { recursive: true, force: true });
    } catch {
      /* best-effort — tmp dir cleanup failures are noise, not signal */
    }
  };

  const handle: GguiServeHandle = {
    baseUrl,
    tempCwd: opts.cwd,
    spawnEnv: freezeEnv(env),
    initialPairCode,
    adminToken,
    readyElapsedMs: Date.now() - spawnStartedAt,
    stderr: watcher.stderr,
    stdout: watcher.stdout,
    close,
    signInAsAdmin: (page) => signInAsAdmin(handle, page),
  };
  return handle;
}

/* The Tasks-mounted serve launcher (`spawnTasksBackedServe` +
 * `tasks-backed-launcher.mts` + the `TSX_BIN` hoisted-bin lookup) was
 * removed alongside the `/s/<shortCode>` console render-viewer specs
 * that were its only callers (`tasks-backed-generation.spec.ts`,
 * `notes-backed-generation.spec.ts`). Canonical render delivery is the
 * MCP-Apps iframe path, covered by the scaffold-render container e2e.
 * The shared Tasks MCP fixture under `fixtures/mcps/tasks/` is unaffected
 * — surviving mount-via-serve fixtures still consume it. */

/**
 * Consume `handle.initialPairCode` via a real `POST /pair` round-trip
 * and return the minted bearer. One code → one token; subsequent
 * calls on the same handle require the caller to mint a fresh code
 * via `POST /admin/pair/init` (exercised in pair-flow.spec.ts).
 *
 * Throws if the handle has no initial code (CLI regression — see
 * `runServe`'s `PAIR_CODE` emitter) or if `/pair` rejects the code
 * for any reason.
 */
export async function mintPairToken(
  handle: GguiServeHandle,
  deviceName = 'journeys-ggui-oss',
): Promise<{ token: string; pairingId: string }> {
  if (!handle.initialPairCode) {
    throw new Error(
      'mintPairToken: harness never parsed a PAIR_CODE beacon from ggui serve stdout — verify the CLI emits `PAIR_CODE <code>\\n` alongside `READY`.',
    );
  }
  const url = `${handle.baseUrl}/pair`;
  assertLocalUrl(url, handle.baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: handle.initialPairCode,
      deviceName,
    }),
  });
  if (res.status !== 200) {
    const bodyText = await res.text();
    throw new Error(
      `mintPairToken: POST /pair returned ${res.status} — body: ${bodyText}`,
    );
  }
  const completion = (await res.json()) as {
    pairingId: string;
    token: string;
  };
  return { token: completion.token, pairingId: completion.pairingId };
}

/**
 * Browser-side admin auth helper. Exchanges the captured `ADMIN_TOKEN`
 * stdout beacon for a `ggui_console_admin` cookie, then stamps the
 * cookie onto the page's browser context so subsequent navigations to
 * `/admin/*` and `/devtools/*` bypass the 302-to-`/admin-login` gate
 * mounted in `packages/mcp-server/src/server.ts` (Slice 4 admin-HTML
 * gate, post-Slice-1 `/admin/*` rename).
 *
 * Wire shape: `POST /ggui/console/admin-login` with `{token}` body. On
 * 204 the server's `Set-Cookie` carries `ggui_console_admin=<token>`
 * and the helper plays it back through `BrowserContext.addCookies`.
 *
 * Throws when:
 *   - The handle has no `adminToken` (CLI didn't emit the beacon — a
 *     real test-infra failure, not a quiet skip).
 *   - The login POST returns non-204 (server is rejecting the token —
 *     real-auth regression).
 *
 * Usage:
 *
 *     await handle.signInAsAdmin(page);   // method form
 *     await signInAsAdmin(handle, page);  // free-function form
 *     await page.goto(`${handle.baseUrl}/admin/blueprints`);
 *
 * Both forms are equivalent; the method form just reads more naturally
 * inside specs that already destructure `handle` once at top.
 */
export async function signInAsAdmin(
  handle: GguiServeHandle,
  page: Page,
): Promise<void> {
  if (!handle.adminToken) {
    throw new Error(
      'signInAsAdmin: harness never parsed an ADMIN_TOKEN beacon from ggui serve stdout — verify the CLI emits `ADMIN_TOKEN <token>\\n` (see `packages/ggui-cli/src/serve-command.ts`).',
    );
  }
  const url = `${handle.baseUrl}/ggui/console/admin-login`;
  assertLocalUrl(url, handle.baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: handle.adminToken }),
    redirect: 'manual',
  });
  if (res.status !== 204) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(
      `signInAsAdmin: POST /ggui/console/admin-login returned ${res.status} — body: ${bodyText}`,
    );
  }
  // Pull the `ggui_console_admin` cookie out of `Set-Cookie` and
  // stamp it onto the Playwright context. We can't ask the server to
  // set a cookie on a page that hasn't navigated yet — Playwright
  // tracks cookies per BrowserContext, so populate the context's
  // cookie jar directly.
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error(
      'signInAsAdmin: 204 response missing Set-Cookie header — server regression, admin gate cookie expected.',
    );
  }
  const match = setCookie.match(/ggui_console_admin=([^;]+)/);
  if (!match) {
    throw new Error(
      `signInAsAdmin: Set-Cookie did not include ggui_console_admin — got: ${setCookie}`,
    );
  }
  const value = match[1]!;
  const baseUrl = new URL(handle.baseUrl);
  await page.context().addCookies([
    {
      name: 'ggui_console_admin',
      value,
      domain: baseUrl.hostname,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

/** Return shape of {@link installNetworkGate}. */
export interface NetworkGate {
  /** Every URL the gate aborted. Specs assert `[]` at teardown. */
  readonly attempts: readonly string[];
  /**
   * Remove the routing rule. Playwright cleans routes up with the page,
   * so this is usually unnecessary — exposed for symmetry.
   */
  readonly dispose: () => Promise<void>;
}

/**
 * Install a `page.route` handler that aborts (and records) any request
 * whose host matches a blocked suffix. The returned `attempts` array is
 * live — specs read it at teardown and assert `expect(attempts).toEqual([])`.
 *
 * Only browser-side calls (page + subresources, iframes, XHR, fetch)
 * go through `page.route`. Node-side outbound `fetch` from the spawned
 * `ggui serve` process is NOT caught here — see the module-level
 * "deliberately does NOT" note.
 */
export async function installNetworkGate(page: Page): Promise<NetworkGate> {
  const attempts: string[] = [];
  await page.route('**/*', async (route: Route, req: Request) => {
    const url = req.url();
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return route.continue();
    }
    const blocked = BLOCKED_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
    if (blocked) {
      attempts.push(url);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return {
    attempts,
    dispose: () => page.unrouteAll({ behavior: 'ignoreErrors' }),
  };
}

/**
 * Assert every test-side fetch (the spec's own direct HTTP calls)
 * targets `baseUrl`. Call this on the URL right before `fetch()`.
 * Cheap self-enforcing guard — keeps the spec honest even if a future
 * edit sneaks in a call to a different host.
 */
export function assertLocalUrl(urlStr: string, baseUrl: string): void {
  const u = new URL(urlStr);
  const b = new URL(baseUrl);
  if (u.host !== b.host) {
    throw new Error(
      `test fetched ${urlStr} — only ${baseUrl} is allowed during a Phase 5 spec`,
    );
  }
}

/**
 * Minimal MCP JSON-RPC helper that speaks to `baseUrl/mcp` with an
 * explicit bearer. Matches the wire shape used by `npx-bootstrap.spec.ts`
 * (stateless Streamable-HTTP) but surfaces the bearer as a required
 * argument so pair-flow specs can pass a minted pairing token vs. a
 * dev token unambiguously.
 *
 * Not a class — just a function — so specs that need two bearers in a
 * row don't pay for instance construction twice.
 */
export async function mcpCallAs(
  baseUrl: string,
  bearer: string,
  method: string,
  params: unknown,
): Promise<{
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}> {
  assertLocalUrl(`${baseUrl}/mcp`, baseUrl);
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      params,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `MCP ${method} failed: HTTP ${res.status} ${res.statusText} — ${await res.text()}`,
    );
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/event-stream')) {
    const body = await res.text();
    const dataLine = body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (!dataLine) {
      throw new Error(`MCP ${method} SSE response had no data frame: ${body}`);
    }
    return JSON.parse(dataLine.slice(5).trim()) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
  }
  return (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

/**
 * Freeze the env we composed so the handle can expose evidence that
 * the banned-prefix sweep has nothing to hide. Values carried for
 * forwarded secrets (`ANTHROPIC_API_KEY`, other BYOK carve-outs) are
 * redacted to `[REDACTED:<length>]` — the KEY's presence is the
 * §4.4 #3 evidence, not the value. Everything that passed through
 * `allowlistedEnv` + `assertNoBannedEnv` is retained by value.
 */
function freezeEnv(env: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv> {
  const redactPrefixes: readonly string[] = [
    'ANTHROPIC_',
    'OPENAI_',
    'GOOGLE_',
    'COHERE_',
    'OPENROUTER_',
  ];
  const frozen: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    if (redactPrefixes.some((p) => k.startsWith(p))) {
      frozen[k] = `[REDACTED:${v.length}]`;
    } else {
      frozen[k] = v;
    }
  }
  return Object.freeze(frozen);
}

/**
 * Recursive file listing of `root`, relative paths, directories
 * suffixed with `/`. Skips `node_modules` (fixture trees that copy
 * one in would balloon the artifact without adding signal). Bounded
 * to {@link MAX_CWD_LISTING_ENTRIES} entries; hitting the cap is
 * itself diagnostic (the temp CWD contains more than a clean-room
 * spec should). Returns a single newline-delimited string.
 */
const MAX_CWD_LISTING_ENTRIES = 500;
function listTreeRelative(root: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_CWD_LISTING_ENTRIES) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_CWD_LISTING_ENTRIES) return;
      if (name === 'node_modules') {
        out.push(`${relative(root, join(dir, name))}/ (skipped)`);
        continue;
      }
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        out.push(`${relative(root, full)}/`);
        walk(full);
      } else {
        out.push(`${relative(root, full)} (${st.size}B)`);
      }
    }
  };
  walk(root);
  if (out.length >= MAX_CWD_LISTING_ENTRIES) {
    out.push(`... (truncated at ${MAX_CWD_LISTING_ENTRIES} entries)`);
  }
  return out.join('\n');
}

/**
 * Convenience — attach the standard failure-capture artifact bundle
 * to the current Playwright test info when a spec fails. Call at the
 * top of an `afterEach` so every failure carries the diagnostic
 * bundle without boilerplate per spec.
 *
 * Attached artifacts (per plan §12.1, Phase 5 "Required" column):
 *   - `ggui-serve.stdout.log` — full child stdout
 *   - `ggui-serve.stderr.log` — full child stderr
 *   - `ggui-serve.tempCwd.txt` — absolute path of the spawned CWD
 *   - `ggui-serve.env.json` — redacted snapshot of the allowlisted
 *     env (evidence for §4.4 #3 invariant)
 *   - `ggui-serve.cwd-listing.txt` — recursive listing of tempCwd
 *     (evidence for §4.4 #1 invariant + §12.1 "dump the on-disk
 *     state at teardown")
 *   - `ggui-serve.ggui-json.txt` — if `<tempCwd>/ggui.json` exists,
 *     its contents verbatim (§12.1 "ggui.json — required")
 */
export async function attachServeArtifacts(
  handle: GguiServeHandle,
  testInfo = test.info(),
): Promise<void> {
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return;
  await testInfo.attach('ggui-serve.stdout.log', {
    body: handle.stdout(),
    contentType: 'text/plain',
  });
  await testInfo.attach('ggui-serve.stderr.log', {
    body: handle.stderr(),
    contentType: 'text/plain',
  });
  await testInfo.attach('ggui-serve.tempCwd.txt', {
    body: handle.tempCwd,
    contentType: 'text/plain',
  });
  await testInfo.attach('ggui-serve.env.json', {
    body: JSON.stringify(handle.spawnEnv, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('ggui-serve.cwd-listing.txt', {
    body: listTreeRelative(handle.tempCwd),
    contentType: 'text/plain',
  });
  const ggJsonPath = join(handle.tempCwd, 'ggui.json');
  if (existsSync(ggJsonPath)) {
    try {
      const body = readFileSync(ggJsonPath, 'utf8');
      await testInfo.attach('ggui-serve.ggui-json.txt', {
        body,
        contentType: 'text/plain',
      });
    } catch {
      /* best-effort; missing/unreadable is not a second failure signal */
    }
  }
}

/**
 * Attach a {@link NetworkGate}'s `attempts` array to the current
 * test info on failure. Plan §12.1 names a HAR as "required" for
 * G14 evidence; `attempts` is the equivalent strong signal captured
 * by the gate's own `page.route` interceptor — the exact URLs the
 * browser tried to reach that matched a {@link BLOCKED_HOST_SUFFIXES}
 * entry. A full HAR would also record permitted calls, but the
 * positive assertion in the spec is already `gate.attempts ===
 * []`; anything non-empty IS the diagnostic we need.
 *
 * Always attaches (even if empty) on failure, so the absence of
 * attempts is explicit rather than implicit.
 */
export async function attachGateAttempts(
  gate: NetworkGate,
  testInfo = test.info(),
): Promise<void> {
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return;
  await testInfo.attach('network-gate.attempts.json', {
    body: JSON.stringify(
      { blockedHostSuffixes: BLOCKED_HOST_SUFFIXES, attempts: gate.attempts },
      null,
      2,
    ),
    contentType: 'application/json',
  });
}
