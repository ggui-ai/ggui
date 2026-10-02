import { describe, expect, it } from 'vitest';
import { EDGE_BLOCKS_EXPRESSION, parseEdgeProbe } from './edge-probe.js';

/**
 * #1663 — the probe's typed read. The expression itself runs in a real browser (rnd's edge-probe-check measures it
 * against the rule table); here only what the page hands back is checked, so a failed measurement is never read as a
 * clean "no offsets".
 */
const ok = {
  blocks: [
    { id: 'band', kind: 'surface', edge: 16, left: 16, right: 800, top: 16 },
    { id: 'title', kind: 'text', edge: 168, left: 168, right: 600, top: 40, within: 'band' },
    { id: 'item', kind: 'text', edge: 32, left: 32, right: 300, top: 120, textEdge: 56, role: 'list-item' },
    { id: 'chips', kind: 'controls', edge: 32, left: 32, right: 288, top: 200 },
  ],
  placeholdersOnly: false,
  skipped: { rowItems: 1, ornaments: 0 },
};

describe('parseEdgeProbe', () => {
  it('reads a well-formed probe, keeping optional fields only when present', () => {
    const p = parseEdgeProbe(ok);
    expect(p?.blocks).toHaveLength(4);
    expect(p?.blocks[1]).toEqual({ id: 'title', kind: 'text', edge: 168, left: 168, right: 600, top: 40, within: 'band' });
    expect(p?.blocks[0]).not.toHaveProperty('within');
    expect(p?.skipped).toEqual({ rowItems: 1, ornaments: 0 });
  });
  it('a page with no #root (null) or any other shape is unmeasured, not empty', () => {
    expect(parseEdgeProbe(null)).toBeNull();
    expect(parseEdgeProbe({ blocks: [], placeholdersOnly: false })).toBeNull();
    expect(parseEdgeProbe('nope')).toBeNull();
  });
  it('one malformed block fails the whole read', () => {
    const bad = (patch: object) => parseEdgeProbe({ ...ok, blocks: [...ok.blocks, { ...ok.blocks[3], ...patch }] });
    expect(bad({ kind: 'image' })).toBeNull();
    expect(bad({ edge: Number.NaN })).toBeNull();
    expect(bad({ role: 'hero' })).toBeNull();
    expect(bad({ within: 3 })).toBeNull();
  });
  it('the expression is plain page JavaScript: no template literals, and it reads only under #root', () => {
    expect(EDGE_BLOCKS_EXPRESSION).not.toContain('`');
    expect(EDGE_BLOCKS_EXPRESSION).toContain("document.getElementById('root')");
    // The decided rules are in it: rows first, ornaments skipped, both counted.
    expect(EDGE_BLOCKS_EXPRESSION).toContain('rowItems: dropped.size');
    expect(EDGE_BLOCKS_EXPRESSION).toContain('ornaments += 1');
  });
});
