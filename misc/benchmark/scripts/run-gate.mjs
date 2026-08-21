/**
 * Change-triggered run gate (founder ruling 2026-08-21, #565 follow-on):
 * the full-coverage bench fires only when a bench-relevant update exists —
 * no idle-week burns, and every published run's delta is meaningful by
 * construction.
 *
 * "An update exists" is defined by the runner image's build commit
 * (`GIT_SHA`, stamped into every report as `meta.version`): the
 * bench-image CI workflow rebuilds ONLY on pushes touching the bench-
 * relevant path set (oss/misc/benchmark/**, oss/packages/ui-gen/**,
 * apps/benchmarks/amplify/**), so image-version ≠ latest-published-version
 * is exactly "the harness/matrix/runner changed since the last run".
 *
 * Long-stop: provider-side drift (a model updated behind an unchanged id)
 * produces no repo change, so after `maxAgeDays` without a run the gate
 * fires anyway — stale numbers must not read as current.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default long-stop: at most this many days between published runs. */
export const MAX_AGE_DAYS = 28;

/**
 * Decide whether this firing should run the bench.
 *
 * @param {object} a
 * @param {string|undefined} a.imageVersion  GIT_SHA baked into the image ('local'/undefined = dev).
 * @param {string|undefined} a.latestVersion `version` of the newest index row (absent pre-2026-08-21).
 * @param {string|undefined} a.latestDate    YYYY-MM-DD of the newest index row.
 * @param {string} a.today                   YYYY-MM-DD.
 * @param {boolean} a.force                  Manual/verify dispatch — always runs (standing P0 rule).
 * @param {number} [a.maxAgeDays]            Long-stop threshold (default MAX_AGE_DAYS).
 * @returns {{ run: boolean, reason: string }}
 */
export function decideBenchRun({ imageVersion, latestVersion, latestDate, today, force, maxAgeDays = MAX_AGE_DAYS }) {
  if (force) {
    return { run: true, reason: 'forced dispatch (BENCH_FORCE) — manual/verify runs never gate' };
  }
  if (!imageVersion || imageVersion === 'local') {
    return { run: true, reason: 'no image version (dev/local run) — gate only applies to the published pipeline' };
  }
  if (!latestVersion || !latestDate) {
    return { run: true, reason: 'no versioned published run to compare against — running' };
  }
  if (latestVersion !== imageVersion) {
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
    reason: `no bench-relevant update since ${latestVersion} (${latestDate}, ${ageDays}d ago) — skipping`,
  };
}
