/**
 * Shared index-headline builder — used by the S3 publisher
 * (run-and-publish.mjs) and the demo sample-data generator
 * (generate-sample-data.mjs) so the two surfaces can't drift.
 *
 * One line per published run: per-variant judge score with its sample
 * size, plus the judge disclosure. `avgScore < 0` is the runner's
 * "not evaluated" sentinel — rendered as `n/a`, never as `-1` or `0`.
 */
export function buildHeadline(report) {
  if (!Array.isArray(report?.variantSummaries)) return undefined;
  const scores = report.variantSummaries
    .map((v) => {
      const score =
        typeof v.avgScore === 'number' && v.avgScore >= 0
          ? String(Math.round(v.avgScore))
          : 'n/a';
      const n = typeof v.totalRuns === 'number' ? ` (n=${v.totalRuns})` : '';
      return `${v.sdkName} ${score}${n}`;
    })
    .join(' / ');
  const judge = report?.meta?.judge;
  const judgeSuffix = judge
    ? ` · judge ${judge.model} (${judge.promptVersion})`
    : ' · unjudged';
  return `${scores}${judgeSuffix}`;
}
