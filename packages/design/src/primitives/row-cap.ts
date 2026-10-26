/**
 * ggui#2010 — the row cap of a wrapping group (`<Row wrap maxRows={n}>`): which children show, decided by the
 * group's own laid-out rows, never by a pixel height.
 *
 * At most `maxRows` rows, as a height bound. A row takes as many rows as its tallest child has lines: a chip wider
 * than the group wraps inside itself, and a three-line pill takes three rows. A child shows only if every row it
 * takes ends within the cap; the cap hides from the first child whose rows would end past it, with every child
 * after it. Each child is whole or absent, never clipped, and the first child always shows, so an overlong first
 * suggestion is never lost (the CDO's end rule, ggui#2010 c.6357159392).
 */

/** One child's laid-out box, relative to the group's top edge, and how many text lines it runs to. */
export interface RowCapBox {
  readonly top: number;
  readonly height: number;
  /** The child's text lines (1 for a one-line chip); a row takes its tallest child's lines. */
  readonly lines: number;
}

/** The attribute a hidden child carries while the cap hides it (also what a probe reads). */
export const ROW_CAP_DROPPED_ATTR = 'data-ggui-row-dropped';

/**
 * The index of the first child to hide so the group's rows end within `maxRows`, or `-1` when every child fits.
 * Rows follow the flex lines: a child begins a new row when its top is at or below the current row's bottom edge
 * (1 px tolerance), which holds whatever the cross-axis alignment, because a wrapped line starts below the line
 * before it. The first child is never hidden.
 */
export function firstHiddenIndex(boxes: readonly RowCapBox[], maxRows: number): number {
  if (maxRows < 1 || !boxes.some((b) => b.height > 0)) return -1;
  let rowsBefore = 0;
  let i = 0;
  while (i < boxes.length) {
    const first = boxes[i];
    if (first === undefined) break;
    let bottom = first.top + first.height;
    let lines = Math.max(1, first.lines);
    let j = i + 1;
    for (; j < boxes.length; j++) {
      const b = boxes[j];
      if (b === undefined || b.top >= bottom - 1) break;
      bottom = Math.max(bottom, b.top + b.height);
      lines = Math.max(lines, b.lines);
    }
    if (i > 0 && rowsBefore + lines > maxRows) {
      // The row would end past the cap. Its children that fit within it still cannot show alone: a row is laid out
      // whole, so the cap starts at the row's first child.
      return i;
    }
    rowsBefore += lines;
    i = j;
  }
  return -1;
}

/** A child's text lines: one, plus its extra height over a one-line child's in whole steps of its line height. */
function linesOf(child: HTMLElement, height: number, oneLine: number): number {
  const cs = getComputedStyle(child);
  const lh = Number.parseFloat(cs.lineHeight);
  const step = Number.isFinite(lh) && lh > 0 ? lh : Number.parseFloat(cs.fontSize) * 1.2;
  if (!Number.isFinite(step) || step <= 0 || height <= oneLine) return 1;
  return 1 + Math.round((height - oneLine) / step);
}

/**
 * Applies the cap to a group element: shows every child, measures them, then hides the tail from
 * {@link firstHiddenIndex}. A hidden child keeps its own inline `display` in a data attribute and gets it back
 * the next time the group is measured.
 */
export function applyRowCap(group: HTMLElement, maxRows: number): void {
  const kids = Array.from(group.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
  for (const kid of kids) {
    if (kid.hasAttribute(ROW_CAP_DROPPED_ATTR)) {
      kid.style.display = kid.getAttribute(ROW_CAP_DROPPED_ATTR) ?? '';
      kid.removeAttribute(ROW_CAP_DROPPED_ATTR);
    }
  }
  const top = group.getBoundingClientRect().top;
  const rects = kids.map((kid) => kid.getBoundingClientRect());
  const heights = rects.map((r) => r.height).filter((h) => h > 0);
  if (heights.length === 0) return;
  const oneLine = Math.min(...heights);
  const boxes = kids.map((kid, k) => {
    const r = rects[k];
    const height = r?.height ?? 0;
    return { top: (r?.top ?? top) - top, height, lines: linesOf(kid, height, oneLine) };
  });
  const cut = firstHiddenIndex(boxes, maxRows);
  if (cut < 0) return;
  for (const kid of kids.slice(cut)) {
    kid.setAttribute(ROW_CAP_DROPPED_ATTR, kid.style.display);
    kid.style.display = 'none';
  }
}
