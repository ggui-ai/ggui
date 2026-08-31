/**
 * Atomically publish a freshly-built output directory over the live one.
 *
 *   node ../scripts/atomic-swap.mjs <stagingDir> <liveDir>
 *
 * Why (ggui#610): the historical build pattern `rm -rf dist && tsc`
 * leaves the package's `dist/` ABSENT for the full duration of the
 * compile — seconds per package. In this monorepo, `dist/` is a live
 * contract: sibling packages' vitest runs resolve workspace imports
 * through it at import-analysis time, and `turbo`'s `^build` dependency
 * rebuilds it from any concurrent invocation (a second terminal, a
 * CI lane, an editor hook). A resolver that lands inside the window
 * fails with "Failed to resolve entry for package" — a red that
 * reproduces only under concurrency and vanishes in isolation
 * (#610's receipted symptom: in-tier fail, 306/306 solo).
 *
 * The fix: build into `<staging>`, then publish it with two directory
 * renames. The live dir's unavailability window shrinks from the whole
 * compile to the microseconds between two `rename(2)` calls — the
 * closest a portable filesystem swap gets to atomic.
 *
 * Not addressed (pre-existing, unchanged): two simultaneous builds of
 * the SAME package still race each other on the staging dir, exactly
 * as they always raced on `dist/` itself.
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const [stagingArg, liveArg] = process.argv.slice(2);
if (!stagingArg || !liveArg) {
  console.error('usage: node atomic-swap.mjs <stagingDir> <liveDir>');
  process.exit(1);
}

const staging = resolve(process.cwd(), stagingArg);
const live = resolve(process.cwd(), liveArg);

if (!existsSync(staging)) {
  console.error(`atomic-swap: staging dir does not exist: ${staging}`);
  process.exit(1);
}
if (staging === live) {
  console.error('atomic-swap: staging and live paths are identical');
  process.exit(1);
}

// Trash is PID-suffixed: two concurrent builds of the same package
// (this session's turbo run + a peer session's async typecheck hook —
// routine in this shared worktree) must never contend on one trash
// name. The original shared `dist.trash` made concurrent swaps
// catastrophic: rm/rename interleavings threw ENOTEMPTY mid-swap and
// left `dist/` ABSENT, and turbo then CACHED the broken tree — the
// resurrecting-corrupt-dist class (#610 postscript). A crashed prior
// swap's stray trash dirs match `dist.trash-*` and are gitignored;
// each process removes only its own on the way out.
const trash = `${live}.trash-${process.pid}`;
rmSync(trash, { recursive: true, force: true });

// The swap: at most one rename separates "old dist" from "new dist".
// Every step tolerates a concurrent sibling winning the same race —
// the invariant is that SOME complete fresh build ends up live, never
// that it is ours.
try {
  if (existsSync(live)) {
    renameSync(live, trash);
  }
} catch {
  // A concurrent swap took `live` between the check and the rename.
}
try {
  renameSync(staging, live);
} catch (err) {
  if (existsSync(live)) {
    // A concurrent build installed its (equally fresh) dist first.
    // Ours is redundant — discard staging and succeed.
    rmSync(staging, { recursive: true, force: true });
  } else {
    rmSync(trash, { recursive: true, force: true });
    throw err;
  }
}

// Cleanup happens AFTER the live dir is whole again — a slow rm of the
// old tree never widens the visibility window.
rmSync(trash, { recursive: true, force: true });
