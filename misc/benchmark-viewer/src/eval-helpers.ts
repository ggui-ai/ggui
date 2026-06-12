/**
 * Runtime accessors for the `evaluation` field on a benchmark report's
 * run results.
 *
 * The on-disk display contract is `EvaluationResultDisplay`
 * (`@ggui-ai/shared`): `score: number` + `dimensions` with the 5
 * dimensions the aesthetic judge measures + `judge` disclosure. These
 * helpers read those fields with explicit runtime checks — a report
 * whose shape drifted (older runner, hand-edited fixture) degrades to
 * `null` instead of rendering garbage.
 */

/** The 5 measured dimensions — mirrors `EvaluationDimensionsDisplay`. */
export interface DimensionScoresShape {
  layout: number;
  designTokens: number;
  hierarchy: number;
  polish: number;
  dataPresentation: number;
}

/** Judge disclosure — mirrors `JudgeDisclosureDisplay`. */
export interface JudgeShape {
  model: string;
  promptVersion: string;
}

export function readEvalScore(evaluation: unknown): number | null {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const e = evaluation as { score?: unknown };
  return typeof e.score === 'number' ? e.score : null;
}

export function readDimensions(evaluation: unknown): DimensionScoresShape | null {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const e = evaluation as { dimensions?: unknown };
  if (!e.dimensions || typeof e.dimensions !== 'object') return null;
  const d = e.dimensions as Partial<DimensionScoresShape>;
  if (
    typeof d.layout !== 'number' ||
    typeof d.designTokens !== 'number' ||
    typeof d.hierarchy !== 'number' ||
    typeof d.polish !== 'number' ||
    typeof d.dataPresentation !== 'number'
  ) {
    return null;
  }
  return {
    layout: d.layout,
    designTokens: d.designTokens,
    hierarchy: d.hierarchy,
    polish: d.polish,
    dataPresentation: d.dataPresentation,
  };
}

export function readJudge(evaluation: unknown): JudgeShape | null {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const e = evaluation as { judge?: unknown };
  if (!e.judge || typeof e.judge !== 'object') return null;
  const j = e.judge as Partial<JudgeShape>;
  if (typeof j.model !== 'string' || typeof j.promptVersion !== 'string') {
    return null;
  }
  return { model: j.model, promptVersion: j.promptVersion };
}
