/**
 * Shared index-headline builder — used by the S3 publisher
 * (run-and-publish.mjs) and the demo sample-data generator
 * (generate-sample-data.mjs) so the two surfaces can't drift.
 *
 * One NEUTRAL line per published run: the matrix size (variants × prompts)
 * plus the judge-panel disclosure. We deliberately do NOT rank providers
 * or imply a winner — the published surface reports per-cell scores, not a
 * leaderboard. Read counts from `report.meta`, falling back to deriving
 * them from the summary arrays. Read the judge panel from
 * `report.meta.judges` (array of `{ model, promptVersion }`).
 */
export function buildHeadline(report) {
  if (!report || typeof report !== 'object') return undefined;

  const totalVariants =
    typeof report.meta?.totalVariants === 'number'
      ? report.meta.totalVariants
      : Array.isArray(report.variantSummaries)
        ? report.variantSummaries.length
        : 0;

  const totalCommits =
    typeof report.meta?.totalCommits === 'number'
      ? report.meta.totalCommits
      : Array.isArray(report.commitSummaries)
        ? report.commitSummaries.length
        : 0;

  const judges = Array.isArray(report.meta?.judges) ? report.meta.judges : [];
  const judgeModels = judges
    .map((j) => j?.model)
    .filter((m) => typeof m === 'string' && m.length > 0);
  const panel =
    judgeModels.length > 0 ? `judged by panel: ${judgeModels.join(', ')}` : 'unjudged';

  return `${totalVariants} variants × ${totalCommits} prompts · ${panel} · per-cell scores, not a ranking`;
}
