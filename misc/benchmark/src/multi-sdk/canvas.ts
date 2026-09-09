import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Rendering-canvas vocabulary (Exp 008 design §4 F5; #973). ONE vocabulary:
 * ui-gen's per-canvas visual evaluator and the arm-B prompt use these same
 * ids and viewports — when ui-gen exports them, this becomes a compile-time
 * pin against that export, not a second definition.
 */
export const CANVAS_CLASSES = ['xs-chat-card', 'mobile-fullscreen-small', 'md', 'lg', 'xl'] as const;
export type CanvasClass = (typeof CANVAS_CLASSES)[number];

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Viewport per class — rnd/exec's shaping (2026-09-09), the five widths the pre-flight render check uses. */
export const CANVAS_VIEWPORTS: Readonly<Record<CanvasClass, Viewport>> = {
  'xs-chat-card': { width: 400, height: 640 },
  'mobile-fullscreen-small': { width: 390, height: 844 },
  md: { width: 768, height: 1024 },
  lg: { width: 1024, height: 768 },
  xl: { width: 1440, height: 900 },
};

/** One canvas's visual-judge output as the evaluator hands it over — PNG still in memory. */
export interface CanvasScreenshot {
  readonly canvas: CanvasClass;
  readonly viewport: Viewport;
  readonly score: number;
  readonly passed: boolean;
  readonly screenshotPng: Buffer;
}

/**
 * What the REPORT carries per canvas: the score and a reference to the PNG
 * written beside the cell's `source.tsx` — path (relative to the cell dir),
 * sha256, bytes. Never the image itself; the PNGs travel in the run's
 * evidence archive (non-public), not under `data/*`.
 */
export interface VisualCanvasArtefact {
  readonly canvas: CanvasClass;
  readonly viewport: Viewport;
  readonly score: number;
  readonly passed: boolean;
  readonly artefact: { readonly path: string; readonly sha256: string; readonly bytes: number };
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
      artefact: {
        path,
        sha256: createHash('sha256').update(c.screenshotPng).digest('hex'),
        bytes: c.screenshotPng.length,
      },
    };
  });
}
