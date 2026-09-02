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
 * Still a race (pre-existing): two simultaneous builds of the SAME
 * package share one staging dir, and tsup's `clean: true` in the second
 * wipes the first's JS mid-flight. What changed (ggui#681): the swap now
 * REFUSES to publish a staging dir that is missing any entry point the
 * package.json declares (`main`/`module`/`types`/`exports`). The losing
 * build exits non-zero — so turbo never caches its partial `dist/` — and
 * the winning build's complete tree is what goes live. Before this gate,
 * a declarations-only `dist/` was swapped live with exit 0, cached under
 * the task hash, and replayed into every fresh pre-push verify worktree
 * fleet-wide (the #681 incident). Removing the race itself (per-process
 * staging dirs) is the follow-up; this gate makes it loud, not silent.
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

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

// ggui#681 completeness gate: every declared entry point that lives under
// the live dir must already exist in staging, or this build is incomplete
// and must fail (never be cached, never go live).
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
const liveRel = relative(process.cwd(), live).split('\\').join('/');
const declared = new Set();
const add = (p) => declared.add(p.replace(/^\.\//, ''));
for (const k of ['main', 'module', 'types']) if (typeof pkg[k] === 'string') add(pkg[k]);
const walk = (v) => {
  if (typeof v === 'string') add(v);
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
};
if (pkg.exports !== undefined) walk(pkg.exports);
const missing = [...declared]
  .filter((p) => p === liveRel || p.startsWith(`${liveRel}/`))
  .filter((p) => !existsSync(join(staging, relative(liveRel, p))));
if (missing.length) {
  console.error(`atomic-swap: refusing to publish ${stagingArg} → ${liveArg}: incomplete build, ${missing.length} declared entry point(s) missing from staging:`);
  for (const m of missing) console.error(`    - ${m}`);
  console.error('atomic-swap: (a concurrent build of this package probably wiped the staging dir mid-flight — re-run the build; ggui#681)');
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

// ggui#694: staging dirs are per-process (`<live>.staging-<pid>`, the
// build script's `$$`), so two concurrent builds of the SAME package never
// share one. A crashed prior build leaves its `<live>.staging-<pid>` behind;
// sweep only those whose pid is DEAD — a live sibling's staging dir is its
// mid-flight build, never ours to touch (mirror of the trash rule above).
const stagingPrefix = `${basename(live)}.staging-`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } };
for (const name of readdirSync(dirname(live))) {
  if (!name.startsWith(stagingPrefix)) continue;
  const pid = Number(name.slice(stagingPrefix.length));
  if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
  rmSync(join(dirname(live), name), { recursive: true, force: true });
}
