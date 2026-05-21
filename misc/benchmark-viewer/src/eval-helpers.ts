/**
 * Runtime accessors for the `evaluation` field on `BenchmarkRunResult`.
 *
 * The field is `EvaluationResult | PostEvalResult | null` per the runner.
 * Both shapes expose `finalScore: number` + `dimensions: DimensionScores`,
 * but the union types live across multiple workspace packages and don't
 * always narrow cleanly across compilation boundaries. These helpers
 * read the fields with explicit runtime checks — robust against schema
 * drift between runner versions, robust against transitive-type
 * resolution failures.
 */

export interface DimensionScoresShape {
  completeness: number;
  visualPolish: number;
  interactivity: number;
  accessibility: number;
  codeQuality: number;
}

export function readEvalScore(evaluation: unknown): number | null {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const e = evaluation as { finalScore?: unknown };
  return typeof e.finalScore === 'number' ? e.finalScore : null;
}

export function readDimensions(evaluation: unknown): DimensionScoresShape | null {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const e = evaluation as { dimensions?: unknown };
  if (!e.dimensions || typeof e.dimensions !== 'object') return null;
  const d = e.dimensions as Partial<DimensionScoresShape>;
  if (
    typeof d.completeness !== 'number' ||
    typeof d.visualPolish !== 'number' ||
    typeof d.interactivity !== 'number' ||
    typeof d.accessibility !== 'number' ||
    typeof d.codeQuality !== 'number'
  ) {
    return null;
  }
  return {
    completeness: d.completeness,
    visualPolish: d.visualPolish,
    interactivity: d.interactivity,
    accessibility: d.accessibility,
    codeQuality: d.codeQuality,
  };
}
