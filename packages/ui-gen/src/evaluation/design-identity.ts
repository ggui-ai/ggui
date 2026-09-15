// The design tree a judge paints with is an INPUT to the judgement and a
// part of its identity (ggui#1042, D3): a judge-only re-judge renders every
// arm with the tree on disk, so the row must say WHICH tree — `srcSha256`
// over every RENDERING INPUT under the design package's `src`, sorted by
// relative path — and the local judge path must accept the tree explicitly.
// A served hello is compared to a judged one only when this hash and the
// runtime's design agree (`design@judge == design@runtime`, generation-triad.md).
//
// Rendering inputs only: tests (`*.test.*`, `__tests__/`), stories
// (`*.stories.*`) and docs (`*.md`) paint nothing, and a built image ships
// the design package without them — the first rows on candidate 34 stamped
// `e2dc89e4…` (123 files) while a checkout of the same git tree computed
// `2cd62cb7…` (199 files). One identity must read the same on every host
// that carries the same rendering inputs.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface JudgeDesignIdentity {
  /** Absolute path of the design `src` tree the judge bundled against. */
  readonly src: string;
  /** sha256 over every rendering input under `src` (see {@link isDesignRenderingInput}) — sorted relative path, then contents. */
  readonly srcSha256: string;
}

/**
 * Whether a file under the design `src` tree is something the judge PAINTS
 * with. Tests, stories and docs are not — and a built image carries the
 * package without them, so they must not move the identity.
 */
export function isDesignRenderingInput(relativePath: string): boolean {
  const rel = relativePath.split('\\').join('/');
  if (rel.startsWith('__tests__/') || rel.includes('/__tests__/')) return false;
  if (/\.test\.[cm]?[jt]sx?$/.test(rel)) return false;
  if (/\.stories\.[cm]?[jt]sx?$/.test(rel)) return false;
  if (rel.endsWith('.md')) return false;
  return true;
}

/** sha256 over every rendering input under `root` (sorted relative path + contents) — the identity of a design tree as it paints. */
export function designTreeSha256(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (isDesignRenderingInput(full.slice(root.length + 1))) files.push(full);
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

const identityCache = new Map<string, JudgeDesignIdentity | null>();

/**
 * The identity of the tree at `src`, computed once per process per path (a
 * judge run paints hundreds of frames from one tree).
 *
 * `null` when the tree cannot be READ (ggui#1110): a deployed image ships the
 * design package as built output with no `src/`, and an identity is a receipt
 * about a judgement — never a precondition for making one. Before this,
 * `scandir` threw ENOENT inside the evaluation round wherever the package ships
 * built output only, the round returned no evaluation at all, and a bar refused
 * a card that had cleared it. A row without the receipt says so; a round that cannot
 * stamp one still runs.
 */
export function judgeDesignIdentity(src: string): JudgeDesignIdentity | null {
  const key = resolve(src);
  const cached = identityCache.get(key);
  if (cached !== undefined) return cached;
  let identity: JudgeDesignIdentity | null;
  try {
    identity = { src: key, srcSha256: designTreeSha256(key) };
  } catch (e) {
    // Unreadable tree: no source directory (a built package), no permission,
    // a path that is not a directory. The reason is logged ONCE per path —
    // the judgement proceeds unstamped rather than not at all.
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[visual-eval] design tree unreadable at ${key} — the judgement carries no design identity (${reason})`);
    identity = null;
  }
  identityCache.set(key, identity);
  return identity;
}

/** Test seam: forget cached identities (a test that rewrites a tree between runs). */
export function resetJudgeDesignIdentityCache(): void {
  identityCache.clear();
}
