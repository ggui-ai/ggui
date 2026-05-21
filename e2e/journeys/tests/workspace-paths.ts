/**
 * Context-independent workspace-path resolution for the
 * `journeys-ggui-oss` Playwright suite.
 *
 * Not a spec — named without the `.spec.` / `.test.` suffix so
 * Playwright's default `testMatch` skips it. The three harness files
 * (`ggui-serve-harness.ts`, `npx-bootstrap.spec.ts`,
 * `tarball-install-harness.ts`) import from here so the path-resolution
 * logic lives in exactly one place — no copy-paste, no drift.
 *
 * ── Why this exists ───────────────────────────────────────────────
 *
 * The same OSS journey suite must run correctly in TWO repository
 * layouts:
 *
 *   1. **Monorepo** (`ggui-workspace`). The suite sits at
 *      `oss/e2e/journeys/`, publishable packages at
 *      `oss/packages/<pkg>/dist/`. The true monorepo root is one level
 *      ABOVE `oss/`. Both `oss/` AND the true root carry a
 *      `pnpm-workspace.yaml` — `oss/` is a nested workspace.
 *
 *   2. **OSS-standalone repo** (`github.com/ggui-ai/ggui`). Produced by
 *      `git subtree split --prefix=oss/`, which STRIPS the `oss/`
 *      prefix. The suite sits at `e2e/journeys/`, packages at
 *      `packages/<pkg>/dist/`, and the repo root IS the workspace root.
 *      Only one `pnpm-workspace.yaml`, at the repo root.
 *
 * A fixed `resolve(__dirname, '../../../..')` is correct for exactly
 * one of those layouts and silently wrong for the other. The helpers
 * below derive the roots by walking the filesystem instead.
 *
 * ── Two distinct roots ───────────────────────────────────────────
 *
 * `packagesRoot()` — the NEAREST ancestor of this file that contains a
 *   `pnpm-workspace.yaml`. In the monorepo that's `oss/`; in the OSS
 *   standalone repo it's the repo root. Publishable `@ggui-ai/*`
 *   packages always live at `<packagesRoot>/packages/<pkg>/`. Use this
 *   to resolve built CLI / console `dist` artifacts.
 *
 * `outermostRoot()` — the FARTHEST ancestor of this file that contains
 *   a `pnpm-workspace.yaml`. In the monorepo that's the true repo root
 *   (one above `oss/`), where pnpm hoists the shared `node_modules` and
 *   where the repo-root `.env` lives. In the OSS standalone repo there
 *   is only one workspace file, so `outermostRoot()` === `packagesRoot()`.
 *   Use this for the hoisted `node_modules/.bin/tsx` binary and `.env`.
 *
 * The two coincide in the standalone layout and diverge in the
 * monorepo — resolving each path against the correct root is the whole
 * point of keeping them separate.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Marker file that identifies a pnpm workspace root. */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/**
 * Walk up from `start` collecting every ancestor directory (including
 * `start` itself) that contains a `pnpm-workspace.yaml`. Returned
 * nearest-first: index 0 is the closest workspace root, the last
 * element is the outermost.
 *
 * Throws if no `pnpm-workspace.yaml` is found anywhere up to the
 * filesystem root — that means the suite is running outside any
 * recognizable ggui checkout, which is an unrecoverable test-infra
 * misconfiguration, not a condition any spec should paper over.
 */
function collectWorkspaceRoots(start: string): readonly string[] {
  const roots: string[] = [];
  let dir = start;
  // `dirname('/')` === '/' — the loop terminates when we stop ascending.
  for (;;) {
    if (existsSync(resolve(dir, WORKSPACE_MARKER))) {
      roots.push(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (roots.length === 0) {
    throw new Error(
      `workspace-paths: no ${WORKSPACE_MARKER} found in any ancestor of ${start}. ` +
        'The journeys suite must run from inside a ggui checkout (monorepo or OSS-standalone).',
    );
  }
  return roots;
}

// Resolved once at module load — `__dirname` here is the `tests/`
// directory in either layout, and the workspace topology is fixed for
// the lifetime of the process.
const WORKSPACE_ROOTS = collectWorkspaceRoots(__dirname);

/**
 * The nearest workspace root above this file — `oss/` in the monorepo,
 * the repo root in the OSS standalone repo. Publishable packages live
 * at `<this>/packages/<pkg>/`.
 */
export const PACKAGES_ROOT: string = WORKSPACE_ROOTS[0]!;

/**
 * The outermost workspace root above this file — the true monorepo
 * root (one above `oss/`) in the monorepo, identical to
 * {@link PACKAGES_ROOT} in the OSS standalone repo. The hoisted
 * `node_modules` and the repo-root `.env` live here.
 */
export const OUTERMOST_ROOT: string =
  WORKSPACE_ROOTS[WORKSPACE_ROOTS.length - 1]!;

/**
 * Absolute path to a publishable package's directory, e.g.
 * `packageDir('ggui-cli')` → `<PACKAGES_ROOT>/packages/ggui-cli`.
 * The `dir` argument is the on-disk directory name, which is NOT
 * always the npm package's unscoped name (`@ggui-ai/react` lives in
 * `packages/ggui-react`, `@ggui-ai/cli` in `packages/ggui-cli`).
 */
export function packageDir(dir: string): string {
  return resolve(PACKAGES_ROOT, 'packages', dir);
}

/**
 * Absolute path to a file inside a publishable package, e.g.
 * `packagePath('ggui-cli', 'dist', 'cli.js')`.
 */
export function packagePath(dir: string, ...segments: string[]): string {
  return resolve(packageDir(dir), ...segments);
}

/**
 * Absolute path to a binary in the hoisted `node_modules/.bin`. pnpm
 * hoists shared dependencies (`tsx`, etc.) to the OUTERMOST workspace
 * root, so this resolves against {@link OUTERMOST_ROOT}, not
 * {@link PACKAGES_ROOT}.
 */
export function hoistedBin(name: string): string {
  return resolve(OUTERMOST_ROOT, 'node_modules', '.bin', name);
}

/**
 * Candidate locations for the optional repo-root `.env`, nearest-first.
 * In the monorepo the `.env` sits at the true root (one above `oss/`);
 * in the OSS standalone repo it sits at the single workspace root. We
 * return BOTH the outermost and the nearest workspace root so the
 * lookup is tolerant of either placement — a missing file at every
 * candidate is fine, every honest spec skips cleanly when its gating
 * env var is absent.
 *
 * De-duplicated when the two roots coincide (the standalone layout).
 */
export function envFileCandidates(): readonly string[] {
  const candidates = [
    resolve(OUTERMOST_ROOT, '.env'),
    resolve(PACKAGES_ROOT, '.env'),
  ];
  return Array.from(new Set(candidates));
}
