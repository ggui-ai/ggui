/**
 * Runtime accessors for the `evaluation` field on a benchmark report's
 * run results.
 *
 * The on-disk display contract is `EvaluationResultDisplay`
 * (`@ggui-ai/shared`): `score: number` (the panel mean) + `dimensions`
 * (panel per-dimension means) + `judges` (distinct panel disclosures) +
 * `panel` (per-judge breakdown) + `spread` (judge disagreement) +
 * optional `critique`. These helpers read those fields with explicit
 * runtime checks — a report whose shape drifted (older runner,
 * hand-edited fixture) degrades to `null` instead of rendering garbage.
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

/**
 * One judge's contribution to the panel — mirrors the subset of
 * `PanelJudgeBreakdownDisplay` the viewer surfaces (model + score).
 */
export interface PanelJudgeShape {
  model: string;
  promptVersion: string;
  score: number;
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

/**
 * Read the panel's distinct judge disclosures (`evaluation.judges[]`).
 * Returns null when the field is absent (older single-judge report) or
 * malformed. Each entry must carry a string model + promptVersion.
 */
export function readJudges(evaluation: unknown): JudgeShape[] | null {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const e = evaluation as { judges?: unknown };
  if (!Array.isArray(e.judges) || e.judges.length === 0) return null;
  const out: JudgeShape[] = [];
  for (const item of e.judges) {
    if (!item || typeof item !== 'object') return null;
    const j = item as Partial<JudgeShape>;
    if (typeof j.model !== 'string' || typeof j.promptVersion !== 'string') {
      return null;
    }
    out.push({ model: j.model, promptVersion: j.promptVersion });
  }
  return out;
}

/**
 * Read the critique paragraph (`evaluation.critique`). Returns null when
 * absent or non-string.
 */
export function readCritique(evaluation: unknown): string | null {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const e = evaluation as { critique?: unknown };
  return typeof e.critique === 'string' ? e.critique : null;
}

/**
 * Read the judge-disagreement spread (`evaluation.spread`, the max−min of
 * the surviving judges' scores). Returns null when absent or non-numeric.
 */
export function readSpread(evaluation: unknown): number | null {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const e = evaluation as { spread?: unknown };
  return typeof e.spread === 'number' ? e.spread : null;
}

/**
 * Read the per-judge breakdown (`evaluation.panel[]`). Each entry must
 * carry a `judge` disclosure (string model + promptVersion) and a numeric
 * `score`. Returns null when the field is absent (older single-judge
 * report) or any entry is malformed — the consumer falls back to "—".
 */
export function readJudgePanel(evaluation: unknown): PanelJudgeShape[] | null {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const e = evaluation as { panel?: unknown };
  if (!Array.isArray(e.panel) || e.panel.length === 0) return null;
  const out: PanelJudgeShape[] = [];
  for (const item of e.panel) {
    if (!item || typeof item !== 'object') return null;
    const p = item as { judge?: unknown; score?: unknown };
    if (typeof p.score !== 'number') return null;
    if (!p.judge || typeof p.judge !== 'object') return null;
    const j = p.judge as Partial<JudgeShape>;
    if (typeof j.model !== 'string' || typeof j.promptVersion !== 'string') {
      return null;
    }
    out.push({ model: j.model, promptVersion: j.promptVersion, score: p.score });
  }
  return out;
}
