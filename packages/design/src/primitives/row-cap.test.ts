// ggui#2010 — the row cap's arithmetic, on laid-out boxes (the browser half is pinned in ui-visual-tester).
import { describe, expect, it } from 'vitest';
import { firstHiddenIndex, type RowCapBox } from './row-cap';

/** One-line chips of height `h`, `counts[r]` to row r, `gap` between rows. */
function rows(counts: readonly number[], h = 30, gap = 8): RowCapBox[] {
  const out: RowCapBox[] = [];
  counts.forEach((n, row) => {
    for (let i = 0; i < n; i++) out.push({ top: row * (h + gap), height: h, lines: 1 });
  });
  return out;
}

describe('firstHiddenIndex (ggui#2010, the end rule): hide from the first child whose rows would end past the cap', () => {
  it('shows everything when the rows fit in the cap', () => {
    expect(firstHiddenIndex(rows([3, 3]), 3)).toBe(-1);
    expect(firstHiddenIndex(rows([3, 3, 2]), 3)).toBe(-1);
  });

  it('hides from the first child of the fourth row', () => {
    // eight chips, one per row (a narrow card): exactly the first three show
    expect(firstHiddenIndex(rows([1, 1, 1, 1, 1, 1, 1, 1]), 3)).toBe(3);
    // 2 + 2 + 2 + 2: the seventh child (index 6) starts row four
    expect(firstHiddenIndex(rows([2, 2, 2, 2]), 3)).toBe(6);
  });

  it('a two-line chip that STARTS on the last row would end past the cap, so it and everything after it hide (the CTO case)', () => {
    // 384 px: two short chips per row on rows 1-2, then a two-line chip beginning row 3 (rows 3-4) and one more
    const boxes: RowCapBox[] = [
      { top: 0, height: 34, lines: 1 },
      { top: 0, height: 34, lines: 1 },
      { top: 42, height: 34, lines: 1 },
      { top: 42, height: 34, lines: 1 },
      { top: 84, height: 54, lines: 2 },
      { top: 146, height: 34, lines: 1 },
    ];
    expect(firstHiddenIndex(boxes, 3)).toBe(4);
  });

  it('the same two-line chip on row 2 ends within the cap and shows; the chip after it would start row 4', () => {
    const boxes: RowCapBox[] = [
      { top: 0, height: 34, lines: 1 },
      { top: 42, height: 54, lines: 2 },
      { top: 104, height: 34, lines: 1 },
    ];
    expect(firstHiddenIndex(boxes, 3)).toBe(2);
  });

  it('a three-line pill takes three rows', () => {
    const boxes: RowCapBox[] = [
      { top: 0, height: 74, lines: 3 },
      { top: 82, height: 34, lines: 1 },
    ];
    expect(firstHiddenIndex(boxes, 3)).toBe(1);
    expect(firstHiddenIndex(boxes, 4)).toBe(-1);
  });

  it('never hides the first child, even one that alone runs past the cap', () => {
    expect(firstHiddenIndex([{ top: 0, height: 4 * 20 + 14, lines: 4 }, { top: 102, height: 34, lines: 1 }], 3)).toBe(1);
    expect(firstHiddenIndex(rows([1, 1]), 1)).toBe(1);
  });

  it('groups a line by overlap, not by equal tops: a centred line keeps its shorter chips in it, and takes its tallest chip\'s lines', () => {
    // a two-line chip with one-line chips centred beside it (their tops are 10 px lower) is ONE row of two lines
    const boxes: RowCapBox[] = [
      { top: 0, height: 54, lines: 2 },
      { top: 10, height: 34, lines: 1 },
      { top: 62, height: 34, lines: 1 },
      { top: 104, height: 34, lines: 1 },
    ];
    expect(firstHiddenIndex(boxes, 3)).toBe(3);
  });

  it('a cap below 1, or no measurable child, caps nothing', () => {
    expect(firstHiddenIndex(rows([1, 1, 1, 1]), 0)).toBe(-1);
    expect(firstHiddenIndex([], 3)).toBe(-1);
    expect(firstHiddenIndex([{ top: 0, height: 0, lines: 1 }], 3)).toBe(-1);
  });
});
