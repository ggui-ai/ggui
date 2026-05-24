/**
 * The OUTERMOST pnpm workspace root above this file.
 *
 * In the monorepo, `oss/` carries its own `pnpm-workspace.yaml` (it
 * becomes the repo-root workspace file in the subtree-split standalone
 * repo). That makes `oss/` a NESTED workspace: any `pnpm` invoked with
 * CWD inside `oss/` walks up, hits `oss/pnpm-workspace.yaml` first, and
 * resolves `oss/` as the workspace root — but the monorepo install
 * hoists dependencies to the TRUE monorepo root, so the nested
 * `oss/node_modules` is empty and hoisted bins (`vite`, `tsx`) aren't
 * found.
 *
 * Spawning `pnpm` with `cwd` set to the outermost workspace root dodges
 * that: in the monorepo it's the true root (deps present); in the
 * OSS-standalone repo there is only one workspace file, so it's the
 * single repo root. Either way `pnpm --filter <pkg> …` resolves against
 * a populated `node_modules`.
 *
 * Used by scenarios 06/07, which spawn `pnpm --filter
 * @ggui-samples/agent-claude-sdk start` — the sample agent needs the
 * hoisted `vite` bin to build its UI.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function findOutermostWorkspaceRoot(start: string): string {
  let dir = start;
  let outermost: string | undefined;
  // `dirname('/')` === '/' — the loop terminates when ascent stops.
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      outermost = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (outermost === undefined) {
    throw new Error(
      `workspace-root: no pnpm-workspace.yaml found above ${start} — ` +
        'the scenarios suite must run from inside a ggui checkout.',
    );
  }
  return outermost;
}

/**
 * Absolute path to the outermost pnpm workspace root. Resolved once at
 * module load — the workspace topology is fixed for the process.
 */
export const OUTERMOST_WORKSPACE_ROOT: string = findOutermostWorkspaceRoot(
  import.meta.dirname,
);
