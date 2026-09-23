import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * The directories whose `.env` / `.env.local` the bench loads, nearest first.
 *
 * Every ancestor of `start` holding a `pnpm-workspace.yaml` is a candidate
 * root: in the monorepo that is `oss/` (the OSS subtree is itself a
 * workspace so it can be mirrored standalone) THEN the repo root, where the
 * keys live; in a standalone OSS checkout the subtree root is the only one.
 *
 * The walk STOPS at the checkout's top level — the first ancestor holding
 * `.git`, which is a directory in a clone and a file in a git worktree. A
 * checkout nested inside another one (a worktree placed under the main
 * clone, a vendored copy) must never load the ENCLOSING checkout's `.env`:
 * that file holds whatever secrets its owner keeps there, none of which the
 * bench run was given. Before this stop, a worktree under the main clone
 * silently loaded the whole enclosing `.env` into every cell process.
 *
 * No root found (a container deploy: no workspace file, no `.git` above
 * the app dir) → `[start]`, so only `start`'s own `.env` is read.
 *
 * @param {string} start  directory to walk up from (the benchmark package dir)
 * @param {(path: string) => boolean} [exists]  injectable for tests
 * @returns {string[]}
 */
export function findEnvRoots(start, exists = existsSync) {
  const roots = [];
  let dir = resolve(start);
  for (let i = 0; i < 6; i += 1) {
    if (exists(resolve(dir, 'pnpm-workspace.yaml'))) roots.push(dir);
    if (exists(resolve(dir, '.git'))) break;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return roots.length > 0 ? roots : [start];
}
