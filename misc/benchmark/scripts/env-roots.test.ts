import { describe, it, expect } from 'vitest';
import { findEnvRoots } from './env-roots.mjs';

/** A fake filesystem: `exists` answers true only for the listed paths. */
function fs(paths: readonly string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe('findEnvRoots', () => {
  it('monorepo clone: the oss/ workspace, then the repo root, nearest first', () => {
    const exists = fs(['/r/.git', '/r/pnpm-workspace.yaml', '/r/oss/pnpm-workspace.yaml']);
    expect(findEnvRoots('/r/oss/misc/benchmark', exists)).toEqual(['/r/oss', '/r']);
  });

  it('a worktree nested inside a clone stops at its own top level, never the enclosing checkout', () => {
    const exists = fs([
      '/r/.git',
      '/r/pnpm-workspace.yaml',
      '/r/.tmp/wt/.git',
      '/r/.tmp/wt/pnpm-workspace.yaml',
      '/r/.tmp/wt/oss/pnpm-workspace.yaml',
    ]);
    const roots = findEnvRoots('/r/.tmp/wt/oss/misc/benchmark', exists);
    expect(roots).toEqual(['/r/.tmp/wt/oss', '/r/.tmp/wt']);
    expect(roots).not.toContain('/r');
  });

  it('standalone OSS checkout: its root is the only workspace root', () => {
    const exists = fs(['/o/.git', '/o/pnpm-workspace.yaml']);
    expect(findEnvRoots('/o/misc/benchmark', exists)).toEqual(['/o']);
  });

  it('container deploy (no workspace file, no .git): the start dir alone', () => {
    expect(findEnvRoots('/app', fs([]))).toEqual(['/app']);
  });
});
