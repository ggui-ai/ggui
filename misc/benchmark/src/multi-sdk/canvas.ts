import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CanvasClass, CanvasVisualResult, CanvasVisualSummary } from '@ggui-ai/ui-gen/evaluation';
import type { EvalResult } from '@ggui-ai/ui-gen/evaluation';

/**
 * Rendering-canvas vocabulary (Exp 008 design §4 F5; #973): ONE definition,
 * ui-gen's — the arm-B prompt, the per-canvas visual evaluator and this
 * runner all read the same ids and viewports. Re-exported here so the bench
 * never reaches past the `./evaluation` subpath.
 */
export { CANVAS_CLASSES, CANVAS_VIEWPORTS } from '@ggui-ai/ui-gen/evaluation';
export type { CanvasClass } from '@ggui-ai/ui-gen/evaluation';

export type Viewport = CanvasVisualSummary['viewport'];

/** The judge's aggregation record per canvas (ggui#1072) — derived from the evaluator's exported summary; the barrel does not re-export `CanvasJudgeRecord` itself. */
export type CanvasJudgeRecord = CanvasVisualSummary['judge'];

/** One canvas's visual-judge output as the evaluator hands it over — PNG still in memory (direct `runVisualEvaluation` call). */
export type CanvasScreenshot = CanvasVisualResult;

/**
 * What the REPORT carries per canvas: the score and, when a PNG was persisted
 * beside the cell's `source.tsx` (the EVAL task path), a reference to it —
 * path (relative to the cell dir), sha256, bytes. Never the image itself; the
 * PNGs travel in the run's evidence archive (non-public), not under `data/*`.
 * `artefact` is absent on the harness path, whose summary is PNG-free by design.
 */
export interface VisualCanvasArtefact {
  readonly canvas: CanvasClass;
  readonly viewport: Viewport;
  readonly score: number;
  /**
   * The JUDGE's verdict for this canvas: `score >= the judge's passThreshold`
   * AND the canvas fits per `canvasFitPolicy` (ggui#1027: an `xs-chat-card`
   * overflow sets this false with the score untouched). It is NOT a bar of the
   * consumer's (the bootstrap binder's 70/70 is applied downstream, on `score`
   * and this flag together). A reader wanting "score ≥ N" recomputes from
   * `score`; a reader wanting "why false at 83" reads `overflow`.
   */
  readonly passed: boolean;
  /** The document's scroll height at this canvas, CSS px; `null` when unmeasurable (ggui#1027 — the fit is on the receipt). */
  readonly contentHeight: number | null;
  /** `contentHeight > viewport.height`, judged per the evaluator's `canvasFitPolicy` (ggui#1027). */
  readonly overflow: boolean;
  /** How `score` was reached (ggui#1072): k vision calls on the same frame, the median as `score`, every sample, σ, and the critique per sample — verbatim from the evaluator. */
  readonly judge: CanvasJudgeRecord;
  /** How the judge composed the mount (ggui#1100): `'fill'` on a fullscreen canvas (root stretched to the frame under the design's fill rule); absent on the inline card. */
  readonly fit?: CanvasVisualSummary['fit'];
  readonly artefact?: { readonly path: string; readonly sha256: string; readonly bytes: number };
}

/** Write `canvas-<class>.png` per entry into `cellDir`; return the report-side refs. */
export function persistCanvasScreenshots(
  cellDir: string,
  canvases: readonly CanvasScreenshot[],
): VisualCanvasArtefact[] {
  return canvases.map((c) => {
    const path = `canvas-${c.canvas}.png`;
    writeFileSync(join(cellDir, path), c.screenshotPng);
    return {
      canvas: c.canvas,
      viewport: c.viewport,
      score: c.score,
      passed: c.passed,
      contentHeight: c.contentHeight,
      overflow: c.overflow,
      judge: c.judge,
      ...(c.fit !== undefined ? { fit: c.fit } : {}),
      artefact: {
        path,
        sha256: createHash('sha256').update(c.screenshotPng).digest('hex'),
        bytes: c.screenshotPng.length,
      },
    };
  });
}

/**
 * The harness path: the in-loop evaluator's per-canvas summary (no PNGs) →
 * the row's `visualCanvases` without `artefact`. Undefined when the evaluator
 * did not run in per-canvas mode.
 */
export function visualCanvasesFromTierEvaluation(
  tierEvaluation: EvalResult | undefined,
): VisualCanvasArtefact[] | undefined {
  const canvases = tierEvaluation?.visual?.canvases;
  if (!canvases || canvases.length === 0) return undefined;
  return canvases.map((c) => ({
    canvas: c.canvas,
    viewport: c.viewport,
    score: c.score,
    passed: c.passed,
    contentHeight: c.contentHeight,
    overflow: c.overflow,
    judge: c.judge,
    ...(c.fit !== undefined ? { fit: c.fit } : {}),
  }));
}
