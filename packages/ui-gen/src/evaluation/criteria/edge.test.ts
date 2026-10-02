import { describe, expect, it } from 'vitest';
import { judgeEdges, type EdgeBlock } from './edge.js';

/**
 * #1663 — the edge rule's verdict on the cards it was written from: every row of the rule's table in
 * docs/design/direction/visual-criteria.md ("The edge rule, measurable"), with each card's edges as the table states
 * them, plus one case per allowed level. Geometry other than the edges (extents, tops) is the minimum the rule reads:
 * stacked blocks overlap horizontally, side-by-side ones do not.
 */
let y = 0;
const at = (): number => (y += 40);
const text = (id: string, edge: number, extra: Partial<EdgeBlock> = {}): EdgeBlock => ({ id, kind: 'text', edge, left: edge, right: 700, top: at(), ...extra });
const controls = (id: string, edge: number, extra: Partial<EdgeBlock> = {}): EdgeBlock => ({ id, kind: 'controls', edge, left: edge, right: 600, top: at(), ...extra });
const surface = (id: string, edge: number, extra: Partial<EdgeBlock> = {}): EdgeBlock => ({ id, kind: 'surface', edge, left: edge, right: 800, top: at(), ...extra });

describe('the edge rule on the cards of its table', () => {
  it('card 1 fails: band outer 16, its text 144, chips 32', () => {
    const v = judgeEdges([surface('band', 16), text('band text', 144, { within: 'band' }), controls('chips', 32)]);
    expect(v.verdict).toBe('fail');
    expect(v.offsets[0]?.offPx).toBe(16);
  });
  it('card 10 fails: band outer 0, its title 16; body 33, chips 32', () => {
    expect(judgeEdges([surface('band', 0), text('title', 16, { within: 'band' }), text('body', 33), controls('chips', 32)]).verdict).toBe('fail');
  });
  it('card 11 passes: band text 144, chips 144 (a band is a ground)', () => {
    expect(judgeEdges([surface('band', 0), text('band text', 144, { within: 'band' }), controls('chips', 144)]).verdict).toBe('pass');
  });
  it('card 8 passes: band text 32 to 33, chips 32', () => {
    expect(judgeEdges([surface('band', 0), text('band text', 33, { within: 'band' }), controls('chips', 32)]).verdict).toBe('pass');
  });
  it('card 50 passes: panel outer 168, its text 200; label 168; a centred group', () => {
    const v = judgeEdges([
      text('label', 168),
      surface('panel', 168),
      text('panel text', 200, { within: 'panel' }),
      { id: 'empty state', kind: 'text', edge: 300, left: 300, right: 468, top: at(), within: 'panel', role: 'centred' },
      { id: 'empty action', kind: 'controls', edge: 334, left: 334, right: 434, top: at(), within: 'panel', role: 'centred' },
    ]);
    expect(v.verdict).toBe('pass');
  });
  it('cards 4 and 16 fail: band text 184 to 186, chips 48 — a 138 px split', () => {
    const v = judgeEdges([surface('band', 16), text('heading', 185, { within: 'band' }), controls('chips', 48)]);
    expect(v.verdict).toBe('fail');
    expect(v.evidence).toContain('px');
  });
  it('card 44 fails: title 66; boxes outer 32, their text 49; inside one box, heading 84 and helper 57', () => {
    const v = judgeEdges([
      text('title', 66),
      surface('box1', 32), text('box1 text', 49, { within: 'box1' }),
      surface('box2', 32), text('heading', 84, { within: 'box2' }), text('helper', 57, { within: 'box2' }),
    ]);
    expect(v.verdict).toBe('fail');
    expect(v.offsets.some((o) => o.container === 'box2')).toBe(true);
  });
  it('card 49 fails: title 66; boxes outer 32, their text 49 to 50', () => {
    expect(judgeEdges([text('title', 66), surface('box1', 32), text('t1', 49, { within: 'box1' }), surface('box2', 32), text('t2', 50, { within: 'box2' })]).verdict).toBe('fail');
  });
  it('card 45 passes: title 34; boxes outer 32, their text 50', () => {
    expect(judgeEdges([text('title', 34), surface('box1', 32), text('t1', 50, { within: 'box1' }), surface('box2', 32), text('t2', 50, { within: 'box2' })]).verdict).toBe('pass');
  });
  it('card 25 fails (chat card): inside the header box, label 226 and its own value 193', () => {
    const v = judgeEdges([
      surface('header', 16),
      { id: 'name', kind: 'text', edge: 32, left: 32, right: 150, top: at(), within: 'header' },
      { id: 'label', kind: 'text', edge: 226, left: 226, right: 330, top: at(), within: 'header' },
      { id: 'value', kind: 'text', edge: 193, left: 193, right: 300, top: at(), within: 'header' },
    ]);
    expect(v.verdict).toBe('fail');
    // Two blocks on two edges: the rule says they disagree, not which one is wrong. The name's own column is untouched.
    expect(v.offsets).toHaveLength(1);
    expect(v.offsets[0]?.offPx).toBe(33);
    expect(v.offsets[0]?.block).not.toBe('name');
  });
  it('card 24 fails: in one box, header icon and timezone 65 to 66 against the table rule, note and button at 57 to 58', () => {
    const v = judgeEdges([
      surface('card box', 32),
      text('header', 65, { within: 'card box', textEdge: 66 }),
      surface('table', 57, { within: 'card box', role: 'table' }),
      text('table text', 74, { within: 'table' }),
      text('note', 57, { within: 'card box' }),
      controls('button', 58, { within: 'card box' }),
    ]);
    expect(v.verdict).toBe('fail');
    expect(v.offsets[0]?.offPx).toBeGreaterThanOrEqual(7);
  });
  it('card 19 fails: band text 104 to 106; list rules, note panel and link 136 to 137', () => {
    const v = judgeEdges([
      surface('band', 16),
      text('band text', 105, { within: 'band' }),
      surface('step list', 136, { role: 'table' }),
      text('step text', 201, { within: 'step list', textEdge: 201 }),
      surface('note panel', 136),
      text('note', 152, { within: 'note panel' }),
      controls('link', 137),
    ]);
    expect(v.verdict).toBe('fail');
  });
});

describe('the two places a block may start next to a band', () => {
  it('in one column, a block on the band’s text edge and another on its outer edge both pass', () => {
    // "next to a box or a band, on the box's own outer edge or on the edge of the text inside it"
    expect(judgeEdges([surface('band', 16), text('band text', 144, { within: 'band' }), text('subtitle', 144), controls('chips', 16)]).verdict).toBe('pass');
  });
  it('a block on neither of the band’s edges fails', () => {
    expect(judgeEdges([surface('band', 16), text('band text', 144, { within: 'band' }), text('subtitle', 144), controls('chips', 60)]).verdict).toBe('fail');
  });
});

describe('the allowed levels', () => {
  it('a hanging marker: what stacks with it may line up with its text edge', () => {
    expect(judgeEdges([text('item', 32, { textEdge: 56 }), text('paragraph', 56)]).verdict).toBe('pass');
  });
  it('a list inside running text: items share an edge of their own, indented', () => {
    expect(judgeEdges([text('paragraph', 32), text('li 1', 48, { role: 'list-item' }), text('li 2', 48, { role: 'list-item' })]).verdict).toBe('pass');
    expect(judgeEdges([text('paragraph', 32), text('li 1', 48, { role: 'list-item' }), text('li 2', 60, { role: 'list-item' })]).verdict).toBe('fail');
  });
  it('columns side by side each keep their own edge', () => {
    const v = judgeEdges([
      { id: 'left a', kind: 'text', edge: 32, left: 32, right: 300, top: at() },
      { id: 'left b', kind: 'text', edge: 33, left: 33, right: 300, top: at() },
      { id: 'right a', kind: 'text', edge: 400, left: 400, right: 700, top: at() },
      { id: 'right b', kind: 'controls', edge: 401, left: 401, right: 700, top: at() },
    ]);
    expect(v.verdict).toBe('pass');
  });
  it('side-by-side boxes under a full-width band are separate columns (card 45 at pane width)', () => {
    // The band spans both columns, so it must not chain the right-hand box into the left column.
    const v = judgeEdges([
      text('title', 16, { right: 113 }),
      surface('band', 16, { right: 800 }),
      text('band text', 33, { within: 'band' }),
      surface('left box', 16, { right: 400 }),
      text('left heading', 32, { within: 'left box', right: 170 }),
      surface('right box', 416, { right: 800 }),
      text('right heading', 432, { within: 'right box', right: 585 }),
    ]);
    expect(v.verdict).toBe('pass');
  });
  it('boxes stacked with no text beside them still share an edge', () => {
    expect(judgeEdges([surface('box1', 32), text('t1', 48, { within: 'box1' }), surface('box2', 56), text('t2', 72, { within: 'box2' })]).verdict).toBe('fail');
    expect(judgeEdges([surface('box1', 32), text('t1', 48, { within: 'box1' }), surface('box2', 32), text('t2', 48, { within: 'box2' })]).verdict).toBe('pass');
  });
  it('a centred group shares one centre axis', () => {
    const ok = judgeEdges([
      { id: 'c1', kind: 'text', edge: 284, left: 284, right: 484, top: at(), role: 'centred' },
      { id: 'c2', kind: 'controls', edge: 334, left: 334, right: 435, top: at(), role: 'centred' },
    ]);
    expect(ok.verdict).toBe('pass');
    const off = judgeEdges([
      { id: 'c1', kind: 'text', edge: 284, left: 284, right: 484, top: at(), role: 'centred' },
      { id: 'c2', kind: 'controls', edge: 300, left: 300, right: 400, top: at(), role: 'centred' },
    ]);
    expect(off.verdict).toBe('fail');
  });
  it('a frame of loading placeholders, or nothing measured, is not evaluated', () => {
    expect(judgeEdges([text('x', 32)], { placeholdersOnly: true }).verdict).toBe('n/a');
    expect(judgeEdges([]).verdict).toBe('n/a');
  });
  it('a heading stacked above its text is not a level (it shares the text’s edge)', () => {
    expect(judgeEdges([text('heading', 16), text('body', 33)]).verdict).toBe('fail');
  });
});
