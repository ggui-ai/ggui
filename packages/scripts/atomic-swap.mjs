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

// A crashed prior swap can leave a trash dir behind; clear it first so
// the rename below cannot collide.
const trash = `${live}.trash`;
rmSync(trash, { recursive: true, force: true });

// The swap: at most one rename separates "old dist" from "new dist".
if (existsSync(live)) {
  renameSync(live, trash);
}
renameSync(staging, live);

// Cleanup happens AFTER the live dir is whole again — a slow rm of the
// old tree never widens the visibility window.
rmSync(trash, { recursive: true, force: true });
