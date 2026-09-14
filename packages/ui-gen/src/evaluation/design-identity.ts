// The design tree a judge paints with is an INPUT to the judgement and a
// part of its identity (ggui#1042, D3): a judge-only re-judge renders every
// arm with the tree on disk, so the row must say WHICH tree — `srcSha256`
// over every file under the design package's `src`, sorted by relative path
// — and the local judge path must accept the tree explicitly. A served
// hello is compared to a judged one only when this hash and the runtime's
// design agree (`design@judge == design@runtime`, generation-triad.md).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface JudgeDesignIdentity {
  /** Absolute path of the design `src` tree the judge bundled against. */
  readonly src: string;
  /** sha256 over every file under `src` — sorted relative path, then contents. */
  readonly srcSha256: string;
}

/** sha256 over every file under `root` (sorted relative path + contents) — the identity of a source tree as it sits on disk. */
export function designTreeSha256(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.slice(root.length + 1) + '\n');
    h.update(readFileSync(f));
    h.update('\n');
  }
  return h.digest('hex');
}

const identityCache = new Map<string, JudgeDesignIdentity>();

/** The identity of the tree at `src`, computed once per process per path (a judge run paints hundreds of frames from one tree). */
export function judgeDesignIdentity(src: string): JudgeDesignIdentity {
  const key = resolve(src);
  const cached = identityCache.get(key);
  if (cached !== undefined) return cached;
  const identity: JudgeDesignIdentity = { src: key, srcSha256: designTreeSha256(key) };
  identityCache.set(key, identity);
  return identity;
}

/** Test seam: forget cached identities (a test that rewrites a tree between runs). */
export function resetJudgeDesignIdentityCache(): void {
  identityCache.clear();
}
