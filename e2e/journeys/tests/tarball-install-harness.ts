/**
 * Phase 5.5 published-artifact smoke — tarball-install harness.
 *
 * Packs `@ggui-ai/cli` and every transitive `@ggui-ai/*` workspace dep
 * via `pnpm pack` into a temp staging dir, then `npm install`s them
 * into a fresh isolated project under `mkdtempSync`. The result is a
 * `node_modules/` tree shaped exactly like what a real OSS user
 * gets from `npm install @ggui-ai/cli` against a public registry —
 * no pnpm workspace symlinks rescuing missing `files[]` entries, no
 * monorepo `node_modules` falling through.
 *
 * Why tarball-install over Verdaccio:
 *   - The repo's `make registry` requires Docker (not available in
 *     every CI lane).
 *   - `pnpm pack` rewrites `workspace:*` → real `version` refs in
 *     each tarball's `package.json` — exactly what `npm publish`
 *     would do. So an `npm install` that resolves those refs against
 *     local `file:./tarballs/<name>.tgz` paths exercises the same
 *     publish-shape contract a registry round-trip would.
 *   - npm `overrides` on the test project's `package.json` lets us
 *     redirect every transitive `@ggui-ai/*` request to a tarball
 *     without polluting the host npm registry or cache.
 *
 * Workspace-leakage prevention:
 *   - CWD for both `npm install` and the spawned `ggui serve` is a
 *     fresh `mkdtempSync(join(tmpdir(), 'ggui-tarball-e2e-'))` —
 *     never the monorepo root.
 *   - `npm` is invoked (not `pnpm`) — pnpm has workspace-aware
 *     rescue paths that would mask publish-shape breakage.
 *   - `npm_config_userconfig` and `npm_config_cache` are set to
 *     temp paths so the host's `~/.npmrc` / `~/.npm/_cacache` are
 *     untouched in either direction.
 *   - Spawned processes inherit the same {PATH, HOME, NODE_ENV}
 *     allowlist used by the existing pair-flow harness — no
 *     `GGUI_*`/`AWS_*`/`COGNITO_*` leak.
 *
 * Out of scope (deferred to later Phase 5.5 slices):
 *   - `@ggui-ai/console` standalone smoke (covered transitively
 *     by the cli install but not asserted as its own artifact).
 *   - `@ggui-ai/project-config` subpath-export assertion.
 *   - `create-ggui-server` scaffold.
 *   - Caching tarballs across runs.
 */
import { test } from '@playwright/test';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { allowlistedEnv, assertNoBannedEnv } from './ggui-serve-harness';

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

/**
 * Every `@ggui-ai/*` workspace package in the transitive dep graph
 * of `@ggui-ai/cli`. Order matters for nothing (npm resolves the
 * graph itself), but completeness matters absolutely — a missing
 * entry surfaces as `npm error 404` against the public registry
 * during install.
 *
 * Derived once by hand from `grep "@ggui-ai/[^\"]*workspace"` over
 * each package.json. If a future package gets added to the cli's
 * graph, it must be added here too — the spec exits non-zero with
 * an actionable npm error if missed.
 */
const TRANSITIVE_PACKAGES: ReadonlyArray<{ dir: string; pkgName: string }> = [
  { dir: 'protocol', pkgName: '@ggui-ai/protocol' },
  { dir: 'agent-runtime', pkgName: '@ggui-ai/agent-runtime' },
  { dir: 'design', pkgName: '@ggui-ai/design' },
  { dir: 'wire', pkgName: '@ggui-ai/wire' },
  { dir: 'shared', pkgName: '@ggui-ai/shared' },
  { dir: 'preview-a2ui', pkgName: '@ggui-ai/preview-a2ui' },
  { dir: 'mcp-server-core', pkgName: '@ggui-ai/mcp-server-core' },
  { dir: 'mcp-server-handlers', pkgName: '@ggui-ai/mcp-server-handlers' },
  { dir: 'ggui-react', pkgName: '@ggui-ai/react' },
  { dir: 'console', pkgName: '@ggui-ai/console' },
  { dir: 'project-config', pkgName: '@ggui-ai/project-config' },
  { dir: 'ui-registry', pkgName: '@ggui-ai/ui-registry' },
  { dir: 'dev-stack', pkgName: '@ggui-ai/dev-stack' },
  { dir: 'mcp-server', pkgName: '@ggui-ai/mcp-server' },
  // `@ggui-ai/ui-gen` is the OSS generation harness. `ggui-cli`
  // imports `createUiGenerator` + `withBrowserCompile` +
  // `selectAdapter` at runtime (see
  // `packages/ggui-cli/src/generation-probe.ts`). Its own runtime
  // imports from `@ggui-ai/mcp-server-core` + `@ggui-ai/protocol`
  // ride in as peerDependencies resolved via the CLI's direct
  // `mcp-server-core` dep + the `mcp-server` → `protocol` chain.
  { dir: 'ui-gen', pkgName: '@ggui-ai/ui-gen' },
  // `@ggui-ai/iframe-runtime` — added as a direct CLI dep in Phase 3 Wave 2
  // Slice 6a (Task #382). CLI imports `RUNTIME_BUNDLE_URL_PATH` from
  // `@ggui-ai/iframe-runtime/server` to compose the absolute `runtimeUrl`
  // the CLI publishes on `_meta.ggui.bootstrap` (fixes srcdoc iframe
  // mount failure — relative paths resolve against `about:srcdoc`).
  // The renderer bundle itself is served to clients at runtime; this
  // tarball entry only covers the `/server` constant + type import.
  { dir: 'iframe-runtime', pkgName: '@ggui-ai/iframe-runtime' },
  // `@ggui-ai/embedding-local` — default OSS embedder, wired in
  // ggui-cli for similarity scoring during cache lookup. Lands in
  // the runtime dep graph via `packages/ggui-cli/src/cli.ts` →
  // `createOnnxEmbedder()`.
  { dir: 'embedding-local', pkgName: '@ggui-ai/embedding-local' },
  // `@ggui-ai/sandbox` — runtime sandboxing primitives the CLI
  // pulls in transitively. Surfaced by the drift-check; declaring
  // here keeps the tarball pack reachable for the OSS smoke spec.
  { dir: 'sandbox', pkgName: '@ggui-ai/sandbox' },
  // Slice 6+7 additions — all reachable from @ggui-ai/cli's runtime
  // dep graph after the gadgets-rename + marketplace + signing slices.
  // Drift-check surfaced these as required; add to keep the tarball
  // smoke spec from 404'ing against the public registry.
  { dir: 'artifact-manifest', pkgName: '@ggui-ai/artifact-manifest' },
  { dir: 'channel-client', pkgName: '@ggui-ai/channel-client' },
  { dir: 'gadget-signing', pkgName: '@ggui-ai/gadget-signing' },
  { dir: 'gadgets', pkgName: '@ggui-ai/gadgets' },
  { dir: 'negotiator', pkgName: '@ggui-ai/negotiator' },
  { dir: 'registry-core', pkgName: '@ggui-ai/registry-core' },
  { dir: 'ui-visual-tester', pkgName: '@ggui-ai/ui-visual-tester' },
];

/** The cli is the install root; kept separate from the override list. */
const CLI_PACKAGE = { dir: 'ggui-cli', pkgName: '@ggui-ai/cli' };

/** Exported so the drift-check test can assert against the same baseline. */
export const TARBALL_TRANSITIVE_PACKAGES = TRANSITIVE_PACKAGES;
export const TARBALL_CLI_PACKAGE = CLI_PACKAGE;

/**
 * Walk the workspace dep graph starting from {@link CLI_PACKAGE} and
 * return every reachable `@ggui-ai/*` package as `{dir, pkgName}`. A
 * `@ggui-ai/*` dep counts whether it's under `dependencies`,
 * `peerDependencies`, or `optionalDependencies` — devDependencies are
 * excluded because npm doesn't install them transitively from a
 * tarball, so they can't affect publish-shape resolution.
 *
 * Missing from {@link TRANSITIVE_PACKAGES} (or extra entries that no
 * longer map to a real `@ggui-ai/*` reachable from the CLI) surface via
 * `diffTarballTransitiveGraph` — the drift-check test treats either
 * direction as a fail and prints an actionable delta.
 *
 * The `packages/` directory scan drives the dir→pkgName map so this
 * helper works against any future package added to the workspace
 * without edits.
 */
export interface TransitiveGraphEntry {
  readonly dir: string;
  readonly pkgName: string;
}

export function computeExpectedTarballTransitives(
  workspaceRoot: string = WORKSPACE_ROOT,
): readonly TransitiveGraphEntry[] {
  const packagesDir = resolve(workspaceRoot, 'oss', 'packages');
  // Build dir→pkgName map + pkgName→runtime-deps map in one scan.
  const pkgDirs = readdirSyncSafe(packagesDir);
  const nameToDir = new Map<string, string>();
  const depsByName = new Map<string, readonly string[]>();
  for (const dir of pkgDirs) {
    const pkgPath = resolve(packagesDir, dir, 'package.json');
    let json: { name?: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    try {
      json = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      continue; // not a package (missing package.json)
    }
    if (typeof json.name !== 'string') continue;
    if (!json.name.startsWith('@ggui-ai/')) continue;
    nameToDir.set(json.name, dir);
    const deps = [
      ...Object.keys(json.dependencies ?? {}),
      ...Object.keys(json.peerDependencies ?? {}),
      ...Object.keys(json.optionalDependencies ?? {}),
    ].filter((name) => name.startsWith('@ggui-ai/'));
    depsByName.set(json.name, deps);
  }
  // BFS from the CLI.
  const visited = new Set<string>();
  const queue = [CLI_PACKAGE.pkgName];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    const deps = depsByName.get(name) ?? [];
    for (const depName of deps) {
      if (visited.has(depName)) continue;
      if (depName === CLI_PACKAGE.pkgName) continue; // CLI is the root
      visited.add(depName);
      queue.push(depName);
    }
  }
  // Emit in a stable alphabetical order so diff output is readable.
  const out: TransitiveGraphEntry[] = [];
  for (const name of Array.from(visited).sort()) {
    const dir = nameToDir.get(name);
    if (dir === undefined) {
      throw new Error(
        `computeExpectedTarballTransitives: ${name} appears in the CLI dep graph but has no packages/* directory on disk`,
      );
    }
    out.push({ dir, pkgName: name });
  }
  return out;
}

/**
 * Compute the delta between the hardcoded {@link TRANSITIVE_PACKAGES}
 * list and the computed expected set from the workspace graph. Returns
 * both directions so the drift-check test can surface adds AND removes
 * in one actionable error.
 */
export function diffTarballTransitiveGraph(
  workspaceRoot: string = WORKSPACE_ROOT,
): {
  readonly missing: readonly TransitiveGraphEntry[];
  readonly extra: readonly TransitiveGraphEntry[];
} {
  const expected = computeExpectedTarballTransitives(workspaceRoot);
  const declared = TRANSITIVE_PACKAGES;
  const expectedNames = new Set(expected.map((e) => e.pkgName));
  const declaredNames = new Set(declared.map((e) => e.pkgName));
  const missing = expected.filter((e) => !declaredNames.has(e.pkgName));
  const extra = declared.filter((e) => !expectedNames.has(e.pkgName));
  return { missing, extra };
}

function readdirSyncSafe(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Map a workspace package's expected tarball filename. `pnpm pack`
 * writes `<scope>-<name>-<version>.tgz` with the scope's `@` and `/`
 * collapsed (`@ggui-ai/cli` → `ggui-ai-cli-<ver>.tgz`).
 */
function tarballFilename(pkgName: string, version: string): string {
  return `${pkgName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

export interface TarballInstallHandle {
  /** The fresh project root where `node_modules/@ggui-ai/cli` lives. */
  readonly installRoot: string;
  /** Where every `pnpm pack` output landed. Useful for failure dumps. */
  readonly tarballsDir: string;
  /** Captured npm install stdout (already finished). */
  readonly installStdout: string;
  /** Captured npm install stderr (already finished). */
  readonly installStderr: string;
  /** Versions of every package that was packed (read off package.json). */
  readonly versions: Readonly<Record<string, string>>;
  /**
   * Per-tarball contents listing from `tar -tzf` on each packed
   * archive. Plan §12.1 names a "tarball-contents listing" as
   * required Phase 5.5 failure evidence. The map key is the pkgName
   * (e.g., `@ggui-ai/cli`); the value is the raw `tar -tzf` output,
   * newline-delimited. Captured once during {@link packAndInstall}
   * so it's available to failure-attach helpers without re-shelling.
   */
  readonly tarballContents: Readonly<Record<string, string>>;
  /** Remove the tarballs dir + install root. Idempotent. */
  close: () => Promise<void>;
}

/**
 * Read a workspace package's version from its package.json. We need
 * this before pack because `pnpm pack` writes
 * `<name>-<version>.tgz` and we need to predict the filename for the
 * `file:` overrides.
 */
function readPackageVersion(pkgDir: string): string {
  const path = resolve(WORKSPACE_ROOT, 'oss', 'packages', pkgDir, 'package.json');
  const raw = readFileSync(path, 'utf8');
  const json = JSON.parse(raw) as { version?: string };
  if (!json.version) {
    throw new Error(`oss/packages/${pkgDir}/package.json has no version`);
  }
  return json.version;
}

/**
 * Pack one workspace package into the staging dir. Returns when the
 * `pnpm pack` child process exits zero. Throws with stderr on
 * non-zero exit.
 */
function packOne(pkgDir: string, tarballsDir: string): Promise<void> {
  return new Promise((done, fail) => {
    const proc = spawn(
      'pnpm',
      ['pack', '--pack-destination', tarballsDir],
      {
        cwd: resolve(WORKSPACE_ROOT, 'oss', 'packages', pkgDir),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('exit', (code) => {
      if (code === 0) done();
      else fail(new Error(`pnpm pack ${pkgDir} exited ${code}: ${stderr}`));
    });
    proc.on('error', fail);
  });
}

/**
 * Pack the cli + every transitive workspace dep in parallel, install
 * them via `npm install` (NOT `pnpm install`) into a fresh tmp
 * project, and return a handle the spec uses to spawn / smoke-import
 * against.
 *
 * Steps:
 *   1. `mkdtempSync` two dirs: `tarballs` for pack output + `install`
 *      for the temp project. Both removed on `close()`.
 *   2. Read every package's version from its workspace `package.json`.
 *      Predict each tarball's filename so we can construct overrides
 *      before pack finishes.
 *   3. Run `pnpm pack` for each package in parallel — packs land in
 *      the staging dir.
 *   4. Write a temp `package.json` declaring `@ggui-ai/cli` as the
 *      single direct `file:` dep + every transitive package in
 *      `overrides` as `file:` paths.
 *   5. `npm install --no-package-lock --no-audit --no-fund` with
 *      `npm_config_cache` + `npm_config_userconfig` set to temp
 *      paths so we don't pollute the host environment.
 *   6. Throw on non-zero install exit; surface npm's stderr verbatim
 *      so a missing transitive entry in `TRANSITIVE_PACKAGES`
 *      becomes a one-line error.
 */
export async function packAndInstall(): Promise<TarballInstallHandle> {
  // Pre-flight drift check. Walking the real workspace graph here —
  // at the single entry point every packaged-smoke path goes through
  // — catches the "a new `@ggui-ai/*` package lands in the CLI graph
  // but `TRANSITIVE_PACKAGES` doesn't get updated" failure mode
  // BEFORE the `pnpm pack` round-trip. Without this the caller would
  // see an opaque `npm error 404 @ggui-ai/<missing>` halfway through
  // install; with it they see the exact missing entries.
  const { missing, extra } = diffTarballTransitiveGraph();
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(
        `TRANSITIVE_PACKAGES is missing ${missing.length} entry(ies) the workspace graph requires: ` +
          missing.map((m) => `{dir:'${m.dir}', pkgName:'${m.pkgName}'}`).join(', '),
      );
    }
    if (extra.length > 0) {
      parts.push(
        `TRANSITIVE_PACKAGES has ${extra.length} entry(ies) that are NOT reachable from @ggui-ai/cli via runtime deps: ` +
          extra.map((m) => `'${m.pkgName}'`).join(', ') +
          '. Remove them — their tarballs are uploaded but no longer used.',
      );
    }
    throw new Error(
      `Tarball smoke drift — TRANSITIVE_PACKAGES in tarball-install-harness.ts is out of sync with the workspace dep graph. ${parts.join(' | ')}`,
    );
  }
  const stagingRoot = mkdtempSync(join(tmpdir(), 'ggui-tarball-e2e-'));
  const tarballsDir = join(stagingRoot, 'tarballs');
  const installRoot = join(stagingRoot, 'install');
  const npmCache = join(stagingRoot, 'npm-cache');
  const npmUserConfig = join(stagingRoot, 'npmrc');
  for (const dir of [tarballsDir, installRoot, npmCache]) {
    spawnSync('mkdir', ['-p', dir]);
  }
  // Empty userconfig file — neutral baseline so npm doesn't read the
  // host's `~/.npmrc`. Anything we want to set goes via `npm_config_*`
  // env vars on the spawn below.
  writeFileSync(npmUserConfig, '');

  // ── 1. snapshot versions ─────────────────────────────────────────
  const versions: Record<string, string> = {};
  for (const { dir, pkgName } of [CLI_PACKAGE, ...TRANSITIVE_PACKAGES]) {
    versions[pkgName] = readPackageVersion(dir);
  }

  // ── 2. pack everything in parallel ───────────────────────────────
  await Promise.all(
    [CLI_PACKAGE, ...TRANSITIVE_PACKAGES].map(({ dir }) =>
      packOne(dir, tarballsDir),
    ),
  );

  // ── 2b. snapshot `tar -tzf` per tarball for failure evidence ────
  //
  // Plan §12.1 names "tarball contents listing" as required Phase 5.5
  // failure evidence. Running `tar -tzf` on each packed archive here
  // (once, sequentially — cheap; ~10KB text per tarball) keeps the
  // diagnostic available to spec-level `afterEach` attach helpers
  // without re-shelling at teardown. `tar` is a POSIX baseline on
  // every runner we care about; an unexpected failure is recorded
  // inline so the absence is visible rather than silent.
  const tarballContents: Record<string, string> = {};
  for (const { pkgName } of [CLI_PACKAGE, ...TRANSITIVE_PACKAGES]) {
    const archive = join(
      tarballsDir,
      tarballFilename(pkgName, versions[pkgName]!),
    );
    const listing = spawnSync('tar', ['-tzf', archive], {
      encoding: 'utf8',
    });
    if (listing.status === 0) {
      tarballContents[pkgName] = listing.stdout ?? '';
    } else {
      tarballContents[pkgName] =
        `[tar -tzf failed for ${archive}]\n` +
        `stderr: ${listing.stderr ?? ''}\n` +
        `status: ${listing.status ?? 'null'}`;
    }
  }

  // ── 3. write the temp project's package.json ─────────────────────
  const tarballFor = (pkgName: string): string =>
    `file:${join(tarballsDir, tarballFilename(pkgName, versions[pkgName]!))}`;
  const overrides: Record<string, string> = {};
  for (const { pkgName } of TRANSITIVE_PACKAGES) {
    overrides[pkgName] = tarballFor(pkgName);
  }
  const projectPkg = {
    name: 'phase55-tarball-smoke',
    version: '0.0.0',
    private: true,
    dependencies: {
      [CLI_PACKAGE.pkgName]: tarballFor(CLI_PACKAGE.pkgName),
    },
    overrides,
  };
  writeFileSync(
    join(installRoot, 'package.json'),
    JSON.stringify(projectPkg, null, 2),
  );

  // ── 4. install with workspace-leakage proofing ───────────────────
  const env = allowlistedEnv();
  // Override-only env vars npm needs to behave on a clean host.
  env['npm_config_cache'] = npmCache;
  env['npm_config_userconfig'] = npmUserConfig;
  // The default `package-lock` setting at the user level would
  // generate a lockfile we don't want lingering for the next run.
  env['npm_config_package_lock'] = 'false';
  env['npm_config_audit'] = 'false';
  env['npm_config_fund'] = 'false';
  assertNoBannedEnv(env);
  const result = spawnSync(
    'npm',
    ['install', '--no-package-lock', '--no-audit', '--no-fund'],
    {
      cwd: installRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    },
  );
  const installStdout = result.stdout ?? '';
  const installStderr = result.stderr ?? '';
  if (result.status !== 0) {
    throw new Error(
      `npm install failed (exit ${result.status}). stderr:\n${installStderr}\nstdout:\n${installStdout}`,
    );
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  return {
    installRoot,
    tarballsDir,
    installStdout,
    installStderr,
    versions,
    tarballContents,
    close,
  };
}

/**
 * Attach the tarball-install handle's captured evidence to the
 * current Playwright test on failure — per plan §12.1 Phase 5.5
 * row. Dumps one artifact per packed tarball (listing), plus the
 * aggregate npm install stdout/stderr.
 *
 * Always writes on failure; the listing is the load-bearing
 * evidence (which files `npm pack` would have published), and the
 * install logs are the fast path to diagnosing a workspace-leak
 * or a missing `files[]` entry.
 *
 * Callers that don't run under Playwright (the fast vitest
 * drift-check test) never reach this function — it's exported
 * for Playwright specs only. The vitest drift-check only touches
 * {@link TARBALL_TRANSITIVE_PACKAGES} + the diff helpers.
 */
export async function attachTarballArtifacts(
  handle: TarballInstallHandle,
  testInfo = test.info(),
): Promise<void> {
  if (testInfo.status === 'passed' || testInfo.status === 'skipped') return;

  await testInfo.attach('tarball-install.stdout.log', {
    body: handle.installStdout,
    contentType: 'text/plain',
  });
  await testInfo.attach('tarball-install.stderr.log', {
    body: handle.installStderr,
    contentType: 'text/plain',
  });
  await testInfo.attach('tarball-install.versions.json', {
    body: JSON.stringify(handle.versions, null, 2),
    contentType: 'application/json',
  });
  // One attachment per tarball so CI's artifact UI renders each as
  // a separate file. Name includes the pkgName with `/` → `__` so
  // the filename stays filesystem-safe.
  for (const [pkgName, listing] of Object.entries(handle.tarballContents)) {
    await testInfo.attach(
      `tarball-listing.${pkgName.replace(/\//g, '__')}.txt`,
      {
        body: listing,
        contentType: 'text/plain',
      },
    );
  }
}

/**
 * Spawn `node ./node_modules/@ggui-ai/cli/dist/cli.js serve --port
 * 0 --mcp-only` from the installed tree. Mirrors the harness shape
 * of {@link import('./ggui-serve-harness').spawnGguiServe} but
 * deliberately does NOT reuse it — that helper spawns from the
 * workspace `dist/cli.js`, which is exactly what Phase 5.5 must
 * NOT exercise. Returns once both READY + PAIR_CODE beacons have
 * landed on stdout.
 */
export interface InstalledServeHandle {
  readonly baseUrl: string;
  readonly initialPairCode: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  close: () => Promise<void>;
}

const READY_TIMEOUT_MS = 20_000;

export async function spawnInstalledGguiServe(
  installRoot: string,
): Promise<InstalledServeHandle> {
  const cliEntry = resolve(
    installRoot,
    'node_modules/@ggui-ai/cli/dist/cli.js',
  );
  let stdoutBuf = '';
  let stderrBuf = '';
  // Per-spawn code cache so the installed server never touches the
  // shared, persistent `~/.ggui/code-cache` — same isolation the
  // workspace `spawnGguiServe` harness applies. Reclaimed in `close()`.
  const codeCacheDir = mkdtempSync(join(tmpdir(), 'ggui-code-cache-e2e-'));
  const env = allowlistedEnv({ codeCacheDir });
  assertNoBannedEnv(env, { skip: ['GGUI_CODE_CACHE_DIR'] });

  const proc: ChildProcessWithoutNullStreams = spawn(
    'node',
    [cliEntry, 'serve', '--port', '0', '--mcp-only'],
    {
      cwd: installRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    },
  ) as ChildProcessWithoutNullStreams;

  const { baseUrl, initialPairCode } = await new Promise<{
    baseUrl: string;
    initialPairCode: string;
  }>((done, fail) => {
    const timer = setTimeout(() => {
      fail(
        new Error(
          `installed ggui serve did not print READY + PAIR_CODE within ${READY_TIMEOUT_MS}ms — stderr:\n${stderrBuf}\nstdout:\n${stdoutBuf}`,
        ),
      );
    }, READY_TIMEOUT_MS);

    let url: string | null = null;
    let code: string | null = null;
    const tryFinish = (): void => {
      if (url !== null && code !== null) {
        clearTimeout(timer);
        done({ baseUrl: url, initialPairCode: code });
      }
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      process.stdout.write(`[installed ggui serve] ${chunk}`);
      stdoutBuf += chunk;
      if (url === null) {
        const m = stdoutBuf.match(/READY\s+(https?:\/\/\S+)/);
        if (m) url = m[1]!;
      }
      if (code === null) {
        const m = stdoutBuf.match(/PAIR_CODE\s+(\d{6})/);
        if (m) code = m[1]!;
      }
      tryFinish();
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      process.stderr.write(`[installed ggui serve:err] ${chunk}`);
      stderrBuf += chunk;
    });
    proc.on('exit', (exitCode) => {
      clearTimeout(timer);
      fail(
        new Error(
          `installed ggui serve exited prematurely with code ${exitCode ?? 'null'} — stderr:\n${stderrBuf}`,
        ),
      );
    });
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (!proc.killed) {
      proc.kill('SIGTERM');
      await new Promise<void>((done2) => {
        const finish = (): void => done2();
        proc.once('exit', finish);
        setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL');
          } catch {
            /* best-effort */
          }
          finish();
        }, 5_000);
      });
    }
    try {
      rmSync(codeCacheDir, { recursive: true, force: true });
    } catch {
      /* best-effort — tmp dir cleanup failures are noise, not signal */
    }
  };

  return {
    baseUrl,
    initialPairCode,
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    close,
  };
}
