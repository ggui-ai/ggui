/**
 * Change-triggered run gate (founder ruling 2026-08-21, #565 follow-on):
 * the full-coverage bench fires only when a bench-relevant update exists —
 * no idle-week burns, and every published run's delta is meaningful by
 * construction.
 *
 * "An update exists" is defined by the triad/runner SOURCE HASH baked into
 * the runner image (`BENCH_SOURCE_HASH` — see `make bench-source-hash`;
 * ggui#766), stamped on each index row as `sourceHash`: the image also
 * rebuilds on pushes that touch only the shared pnpm-lock.yaml, and a
 * rebuild with an unchanged source hash is NOT an update. The image commit
 * (`GIT_SHA`, `meta.version`) is the fallback compare for rows published
 * before the hash existed. Empty/sentinel hashes ('', 'dev', 'local') count
 * as ABSENT so a failed bake can never mint a run or a forever-skip.
 *
 * Long-stop: provider-side drift (a model updated behind an unchanged id)
 * produces no repo change, so after `maxAgeDays` without a run the gate
 * fires anyway — stale numbers must not read as current.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default long-stop: at most this many days between published runs. */
export const MAX_AGE_DAYS = 28;

/**
 * A source hash is "real" only when it is non-empty and not a build
 * sentinel. The Dockerfile defaults BENCH_SOURCE_HASH to 'dev' (raw
 * `docker build` without the Makefile) and a failed bake yields ''; both
 * must read as ABSENT — never as a value to compare or to stamp — or a
 * self-publisher's image would compare 'dev' to 'dev' and skip until the
 * long-stop, and a failed bake would mint one spurious run. Shared by the
 * gate (compare) and run-and-publish (stamp) so the two can't disagree.
 */
export function isRealSourceHash(hash) {
  return typeof hash === 'string' && hash.length > 0 && hash !== 'dev' && hash !== 'local';
}

/**
 * Decide whether this firing should run the bench.
 *
 * @param {object} a
 * @param {string|undefined} a.imageVersion  GIT_SHA baked into the image ('local'/undefined = dev).
 * @param {string|undefined} a.latestVersion `version` of the newest index row (absent pre-2026-08-21).
 * @param {string|undefined} a.latestDate    YYYY-MM-DD of the newest index row.
 * @param {string} a.today                   YYYY-MM-DD.
 * @param {boolean} a.force                  Manual/verify dispatch — always runs (standing P0 rule).
 * @param {{ issues?: Array<{ number: number, title?: string }> }} [a.hold]
 *   The fleet main-hold marker (`data/HOLD.json`, mirrored from open
 *   `hold:main` issues by the bench-hold-mirror workflow — #684). A marker
 *   naming at least one issue means a commit escaped onto main ahead of its
 *   verdict: the probe must not measure it. Checked BEFORE update detection.
 * @param {string|undefined} [a.imageSourceHash]
 *   BENCH_SOURCE_HASH baked into the image (ggui#766): sha256 of the git
 *   tree hashes of oss/packages/ui-gen/src, oss/misc/benchmark/src,
 *   oss/misc/benchmark/scripts and the package.json of ui-gen / benchmark /
 *   protocol / shared (`make bench-source-hash`). This is what the bench
 *   MEASURES; the image also rebuilds on unrelated pnpm-lock churn, and
 *   that is not an update.
 * @param {string|undefined} [a.latestSourceHash]
 *   `sourceHash` of the newest index row (absent on rows before 2026-09-03).
 *   When BOTH hashes are present they decide; otherwise the version
 *   compare below still applies.
 * @param {number} [a.maxAgeDays]            Long-stop threshold (default MAX_AGE_DAYS).
 * @returns {{ run: boolean, reason: string }}
 */
export function decideBenchRun({
  imageVersion,
  latestVersion,
  latestDate,
  today,
  force,
  hold,
  imageSourceHash,
  latestSourceHash,
  maxAgeDays = MAX_AGE_DAYS,
}) {
  const holdIssues = hold?.issues ?? [];
  const holdList = holdIssues.map((i) => `#${i.number}${i.title ? ` ${i.title}` : ''}`).join(', ');
  if (force) {
    return {
      run: true,
      reason: holdIssues.length > 0
        ? `forced dispatch (BENCH_FORCE) DESPITE main-hold ${holdList} — a human chose to run`
        : 'forced dispatch (BENCH_FORCE) — manual/verify runs never gate',
    };
  }
  if (holdIssues.length > 0) {
    return { run: false, reason: `HOLD ${holdList}: main-hold marker present (data/HOLD.json) — skipping` };
  }
  if (!imageVersion || imageVersion === 'local') {
    return { run: true, reason: 'no image version (dev/local run) — gate only applies to the published pipeline' };
  }
  if (!latestVersion || !latestDate) {
    return { run: true, reason: 'no versioned published run to compare against — running' };
  }
  // Source-hash compare (ggui#766) decides when both sides carry it; the
  // image commit is only a fallback for rows that predate the field.
  const bySource = isRealSourceHash(imageSourceHash) && isRealSourceHash(latestSourceHash);
  if (bySource && imageSourceHash !== latestSourceHash) {
    return {
      run: true,
      reason: `update exists: source hash ${imageSourceHash} ≠ last published ${latestSourceHash} (image ${imageVersion})`,
    };
  }
  if (!bySource && latestVersion !== imageVersion) {
    return { run: true, reason: `update exists: image ${imageVersion} ≠ last published ${latestVersion}` };
  }
  const ageDays = Math.floor((Date.parse(today) - Date.parse(latestDate)) / DAY_MS);
  if (ageDays >= maxAgeDays) {
    return {
      run: true,
      reason: `long-stop: last run (${latestDate}) is ${ageDays}d old ≥ ${maxAgeDays}d — provider-side drift check`,
    };
  }
  return {
    run: false,
    reason: bySource
      ? `no bench-relevant update: source hash ${imageSourceHash} unchanged since ${latestVersion} (${latestDate}, ${ageDays}d ago${
          imageVersion !== latestVersion ? `; image ${imageVersion} rebuilt on unrelated changes` : ''
        }) — skipping`
      : `no bench-relevant update since ${latestVersion} (${latestDate}, ${ageDays}d ago) — skipping`,
  };
}
