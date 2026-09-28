// ggui#1492 — the host's presentation of each judged canvas, carried as DATA in judge-input.json
// (`canvasPresentations`) so no host constant lives in the judge: the box a companion canvas is captured at,
// the ground the pane shows around it, and the frame an inline card sits in. The eval cell echoes what it
// APPLIED into report.json (`presentation`), and the binder digests that echo — never the writer's input.
//
// The writer owns the field; this reader duplicates its rules because the eval cell cannot import the
// writer's package. Both readers are pinned to ONE vector table (`__fixtures__/presentation-vectors.json`,
// a byte copy of the writer's; its sha is pinned in presentation.test.ts), so the two copies cannot drift.
//
// Rules (absent ⇒ today, byte-identical; a malformed entry drops ONLY its own canvas and is named, never silent):
//   an entry that is not an object ⇒ `not_an_object`; the field itself not an array ⇒ one `not_an_object` for `*`
//   a canvas outside the canvas classes ⇒ `unknown_canvas`; two entries for one canvas ⇒ each `duplicate_canvas`
//   a canvas this cell does not judge ⇒ `canvas_not_judged`; a missing or blank label ⇒ `label_missing`
//   a box outside 200..2560 integer px ⇒ `box_out_of_bounds`; a box on the declared primary ⇒ `box_on_declared_primary`
//     (the declared viewport already boxes it — one box per canvas); framing the primary is allowed
//   a top-level ground on the inline card ⇒ `ground_on_inline` (its room is `frame.ground`)
//   a ground or frame colour that is not lowercase `#rrggbb` ⇒ `color_not_hex`
//   a frame number outside the judge's bounds (ring 0..8 px, alpha 0..1, radius 0..64 px, floor 0..2560 px) ⇒ `frame_malformed`
//   a frame on any canvas but the inline card ⇒ `frame_off_inline`; a frame missing a member ⇒ `frame_malformed`

import type { JsonObject, JsonValue } from '@ggui-ai/protocol';
import {
  CANVAS_CLASSES,
  HOST_COLOUR_PATTERN,
  HOST_FRAME_BOUNDS,
  type HostPresentationIgnoredReason,
  type VisualEvalConfig,
} from '@ggui-ai/ui-gen/evaluation';
import type { CanvasClass, CanvasScreenshot } from '../multi-sdk/canvas.js';

/** The judge's per-canvas capture boxes, as its config types them. */
export type JudgeCanvasViewports = NonNullable<VisualEvalConfig['canvasViewports']>;
/** The judge's per-canvas host presentations, as its config types them. */
export type JudgeHostPresentations = NonNullable<VisualEvalConfig['hostPresentations']>;

// The colour form and the frame's numeric bounds are the JUDGE's own (`HOST_COLOUR_PATTERN`, `HOST_FRAME_BOUNDS`),
// imported rather than restated: an entry this reader applies is one the judge draws, so the echo never names a
// frame the judge ignored. The box bounds belong to the contract alone (the judge takes any box it is given).
/** A presentation box's bounds, in integer px, per side. */
export const PRESENTATION_BOX_BOUNDS = { min: 200, max: 2560 } as const;
/** The one canvas a host frame may wrap. */
const INLINE_CANVAS: CanvasClass = 'xs-chat-card';

/** The frame the host draws around an inline card: its surface, the room around it, the ring and the corner. */
export interface InlineHostFrame {
  readonly surface: string;
  readonly ground: string;
  readonly ring: { readonly widthPx: number; readonly color: string; readonly alpha: number };
  readonly radiusPx: number;
  readonly minHeightPx?: number;
}

/** One judged canvas as the host presents it. */
export interface CanvasPresentation {
  readonly canvas: CanvasClass;
  /** Names the presentation to the judge; it reaches the prompt, so it is part of the digest. */
  readonly label: string;
  /** The box a companion canvas is captured at (never on the declared primary). */
  readonly box?: { readonly width: number; readonly height: number };
  /** The ground the host shows around the capture. */
  readonly ground?: string;
  /** The inline card's frame (the inline card only). */
  readonly frame?: InlineHostFrame;
}

export const PRESENTATION_MALFORMED_REASONS = [
  'not_an_object',
  'unknown_canvas',
  'canvas_not_judged',
  'duplicate_canvas',
  'label_missing',
  'box_out_of_bounds',
  'box_on_declared_primary',
  'color_not_hex',
  'frame_off_inline',
  'frame_malformed',
  // The inline card's room lives on `frame.ground`, and the judge would draw that one instead — so an inline
  // entry carrying a top-level `ground` is refused, never half-applied.
  'ground_on_inline',
] as const;
export type PresentationMalformedReason = (typeof PRESENTATION_MALFORMED_REASONS)[number];

/** A dropped entry: its canvas (`*` for the whole field, `?` when the entry names none) and why. */
export interface PresentationMalformed {
  readonly canvas: string;
  readonly reason: PresentationMalformedReason;
}

/** What the reader applied and what it dropped — the shape echoed into report.json as `presentation`. */
export interface PresentationRead {
  readonly applied: readonly CanvasPresentation[];
  readonly malformed: readonly PresentationMalformed[];
}

/** JSON's objects and arrays — the writer's `typeof x === 'object' && x !== null`, kept exactly so both readers agree on an array entry. */
type JsonContainer = JsonObject | JsonValue[];

function isContainer(value: JsonValue | undefined): value is JsonContainer {
  return typeof value === 'object' && value !== null;
}

/** A named member of a JSON object; an array has none. */
function member(container: JsonContainer, name: string): JsonValue | undefined {
  if (Array.isArray(container)) return undefined;
  return Object.prototype.hasOwnProperty.call(container, name) ? container[name] : undefined;
}

function isCanvas(value: JsonValue | undefined): value is CanvasClass {
  return typeof value === 'string' && CANVAS_CLASSES.some((c) => c === value);
}

function isPx(value: JsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function inBounds(value: JsonValue | undefined): value is number {
  return isPx(value) && value >= PRESENTATION_BOX_BOUNDS.min && value <= PRESENTATION_BOX_BOUNDS.max;
}

function isHex(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && HOST_COLOUR_PATTERN.test(value);
}

/** An integer px within one of the judge's frame bounds. */
function within(value: JsonValue | undefined, bound: { readonly min: number; readonly max: number }): value is number {
  return isPx(value) && value >= bound.min && value <= bound.max;
}

function readFrame(raw: JsonValue): InlineHostFrame | 'color_not_hex' | 'frame_malformed' {
  if (!isContainer(raw)) return 'frame_malformed';
  const surface = member(raw, 'surface');
  const ground = member(raw, 'ground');
  const ring = member(raw, 'ring');
  const radiusPx = member(raw, 'radiusPx');
  const minHeightPx = member(raw, 'minHeightPx');
  if (!isContainer(ring)) return 'frame_malformed';
  const ringWidth = member(ring, 'widthPx');
  const ringColor = member(ring, 'color');
  const ringAlpha = member(ring, 'alpha');
  if (!isHex(surface) || !isHex(ground) || !isHex(ringColor)) return 'color_not_hex';
  if (!within(ringWidth, HOST_FRAME_BOUNDS.ringWidthPx) || !within(radiusPx, HOST_FRAME_BOUNDS.radiusPx)) return 'frame_malformed';
  const alpha = HOST_FRAME_BOUNDS.ringAlpha;
  if (typeof ringAlpha !== 'number' || !(ringAlpha >= alpha.min && ringAlpha <= alpha.max)) return 'frame_malformed';
  if (minHeightPx !== undefined && !within(minHeightPx, HOST_FRAME_BOUNDS.minHeightPx)) return 'frame_malformed';
  return {
    surface,
    ground,
    ring: { widthPx: ringWidth, color: ringColor, alpha: ringAlpha },
    radiusPx,
    ...(minHeightPx !== undefined ? { minHeightPx } : {}),
  };
}

/**
 * Read judge-input.json's `canvasPresentations` for a cell that judges `judged`, whose declared primary
 * (judge-input `canvasViewport.canvas`) is `declaredPrimary`. `applied` keeps input order; the binder's digest
 * sorts on its own.
 */
export function readCanvasPresentations(
  raw: JsonValue | undefined,
  judged: readonly CanvasClass[],
  declaredPrimary?: CanvasClass,
): PresentationRead {
  if (raw === undefined) return { applied: [], malformed: [] };
  if (!Array.isArray(raw)) return { applied: [], malformed: [{ canvas: '*', reason: 'not_an_object' }] };

  const counts = new Map<string, number>();
  for (const entry of raw) {
    const canvas = isContainer(entry) ? member(entry, 'canvas') : undefined;
    if (typeof canvas === 'string') counts.set(canvas, (counts.get(canvas) ?? 0) + 1);
  }

  const applied: CanvasPresentation[] = [];
  const malformed: PresentationMalformed[] = [];
  for (const entry of raw) {
    if (!isContainer(entry)) {
      malformed.push({ canvas: '?', reason: 'not_an_object' });
      continue;
    }
    const canvas = member(entry, 'canvas');
    if (!isCanvas(canvas)) {
      malformed.push({ canvas: typeof canvas === 'string' ? canvas : '?', reason: 'unknown_canvas' });
      continue;
    }
    if ((counts.get(canvas) ?? 0) > 1) {
      malformed.push({ canvas, reason: 'duplicate_canvas' });
      continue;
    }
    if (!judged.includes(canvas)) {
      malformed.push({ canvas, reason: 'canvas_not_judged' });
      continue;
    }
    const label = member(entry, 'label');
    if (typeof label !== 'string' || label.trim().length === 0) {
      malformed.push({ canvas, reason: 'label_missing' });
      continue;
    }
    const box = member(entry, 'box');
    let readBox: { readonly width: number; readonly height: number } | undefined;
    if (box !== undefined) {
      const width = isContainer(box) ? member(box, 'width') : undefined;
      const height = isContainer(box) ? member(box, 'height') : undefined;
      if (!inBounds(width) || !inBounds(height)) {
        malformed.push({ canvas, reason: 'box_out_of_bounds' });
        continue;
      }
      if (canvas === declaredPrimary) {
        malformed.push({ canvas, reason: 'box_on_declared_primary' });
        continue;
      }
      readBox = { width, height };
    }
    const ground = member(entry, 'ground');
    if (ground !== undefined && canvas === INLINE_CANVAS) {
      malformed.push({ canvas, reason: 'ground_on_inline' });
      continue;
    }
    if (ground !== undefined && !isHex(ground)) {
      malformed.push({ canvas, reason: 'color_not_hex' });
      continue;
    }
    const frameRaw = member(entry, 'frame');
    let frame: InlineHostFrame | undefined;
    if (frameRaw !== undefined) {
      if (canvas !== INLINE_CANVAS) {
        malformed.push({ canvas, reason: 'frame_off_inline' });
        continue;
      }
      const read = readFrame(frameRaw);
      if (read === 'color_not_hex' || read === 'frame_malformed') {
        malformed.push({ canvas, reason: read });
        continue;
      }
      frame = read;
    }
    applied.push({
      canvas,
      label: label.trim(),
      ...(readBox !== undefined ? { box: readBox } : {}),
      ...(isHex(ground) ? { ground } : {}),
      ...(frame !== undefined ? { frame } : {}),
    });
  }
  return { applied, malformed };
}

/**
 * The judge's `canvasViewports`: the declared primary's box (judge-input `canvasViewport`) plus every applied
 * presentation's box. The rules keep a presentation box off the declared primary, so the two never collide.
 * Absent when neither exists, so a cell without either keeps today's config.
 */
export function canvasViewportsFor(
  declared: { readonly canvas: CanvasClass; readonly width: number; readonly height: number } | undefined,
  applied: readonly CanvasPresentation[],
): JudgeCanvasViewports | undefined {
  const boxes: Partial<Record<CanvasClass, { readonly width: number; readonly height: number }>> = {};
  if (declared !== undefined) boxes[declared.canvas] = { width: declared.width, height: declared.height };
  for (const p of applied) {
    if (p.box !== undefined) boxes[p.canvas] = { width: p.box.width, height: p.box.height };
  }
  return Object.keys(boxes).length > 0 ? boxes : undefined;
}

/**
 * The judge's `hostPresentations`: each applied presentation's label, ground and frame, copied as read (the box
 * travels in `canvasViewports`). Absent when nothing applied, so a cell without the field keeps today's config.
 */
export function hostPresentationsFor(applied: readonly CanvasPresentation[]): JudgeHostPresentations | undefined {
  if (applied.length === 0) return undefined;
  const byCanvas: Partial<Record<CanvasClass, JudgeHostPresentations[CanvasClass]>> = {};
  for (const p of applied) {
    byCanvas[p.canvas] = {
      label: p.label,
      ...(p.ground !== undefined ? { ground: p.ground } : {}),
      ...(p.frame !== undefined ? { frame: p.frame } : {}),
    };
  }
  return byCanvas;
}

/** Why an entry is not in the echo's `applied`: this reader's pre-check, or the judge's own verdict. */
export type PresentationEchoReason = PresentationMalformedReason | HostPresentationIgnoredReason;

/**
 * report.json's top-level `presentation`, which the binder digests: what the JUDGE drew, never this reader's
 * prediction. `applied` is every canvas whose judge outcome is `applied`, as the judge reports it drew it, with
 * `canvas` and the box this cell handed it (`canvasViewports`) added back. `malformed` is this reader's drops (`by: 'reader'`),
 * then every entry the judge set aside, with the judge's reason (`by: 'judge'`).
 */
export interface PresentationEcho {
  readonly applied: readonly CanvasPresentation[];
  /** `by` names who dropped the entry: this reader's pre-check, or the judge (two readers of one contract disagreeing). */
  readonly malformed: readonly { readonly canvas: string; readonly reason: PresentationEchoReason; readonly by: 'reader' | 'judge' }[];
}

/**
 * Build the echo from the pre-check read and the judge's per-canvas results. An entry handed to the judge with no
 * outcome on its canvas (the judge did not run that canvas, or did not run) is in neither list — it was not drawn,
 * and it was not malformed; it is returned as `unreported` so the caller names it on the row.
 */
export function presentationEcho(
  read: PresentationRead,
  judged: readonly Pick<CanvasScreenshot, 'canvas' | 'presentation'>[] | undefined,
): {
  readonly echo: PresentationEcho;
  /** The entries the judge set aside, with its reason — also in `echo.malformed`, returned apart so the caller notes them. */
  readonly judgeIgnored: PresentationEcho['malformed'];
  readonly unreported: readonly CanvasClass[];
} {
  const outcomes = new Map((judged ?? []).map((c) => [c.canvas, c.presentation] as const));
  const applied: CanvasPresentation[] = [];
  const ignored: { canvas: string; reason: PresentationEchoReason; by: 'judge' }[] = [];
  const unreported: CanvasClass[] = [];
  for (const p of read.applied) {
    const outcome = outcomes.get(p.canvas);
    if (outcome === undefined) {
      unreported.push(p.canvas);
      continue;
    }
    if (outcome.status === 'ignored') {
      ignored.push({ canvas: p.canvas, reason: outcome.reason, by: 'judge' });
      continue;
    }
    const drawn = outcome.applied;
    applied.push({
      canvas: p.canvas,
      label: drawn.label,
      ...(p.box !== undefined ? { box: p.box } : {}),
      ...(drawn.ground !== undefined ? { ground: drawn.ground } : {}),
      ...(drawn.frame !== undefined ? { frame: drawn.frame } : {}),
    });
  }
  const byReader = read.malformed.map((m) => ({ canvas: m.canvas, reason: m.reason, by: 'reader' as const }));
  return { echo: { applied, malformed: [...byReader, ...ignored] }, judgeIgnored: ignored, unreported };
}
