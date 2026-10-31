// #1765 — `space.edge.v3`'s build checks and synthetic seeds, as pre-registered on the row. The three seeds are cells of
// the sealed v2 draw, read by the v3 probe in a real browser; they are build checks, never validation evidence (rules 1
// and 3 were written to fail #11 and #17). v1 and v2 are separate, frozen instruments and are not touched here.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEdgeProbeV3 } from './edge-probe-v3.js';
import { judgeEdgesV3, type EdgeBlockV3, type EdgeOffsetV3 } from './edge-v3.js';

const here = dirname(fileURLToPath(import.meta.url));
interface Seed {
  readonly cell: string;
  readonly canvas: string;
  readonly expect: 'pass' | 'fail';
  readonly read: unknown;
}
const fixture: { readonly seeds: Readonly<Record<string, Seed>> } = JSON.parse(readFileSync(resolve(here, '__fixtures__/edge-v3-seeds.json'), 'utf8'));
const judge = (seed: Seed) => {
  const probe = parseEdgeProbeV3(seed.read);
  expect(probe).not.toBeNull();
  return judgeEdgesV3(probe!.blocks, { cardContent: probe!.cardContent, placeholdersOnly: probe!.placeholdersOnly, unpainted: probe!.unpainted });
};
const seed = (k: string): Seed => {
  const s = fixture.seeds[k];
  if (s === undefined) throw new Error(`no seed ${k}`);
  return s;
};

describe('space.edge.v3 build checks on the seeds (#1765)', () => {
  for (const [k, s] of Object.entries(fixture.seeds)) {
    it(`#${k} ${s.cell} at ${s.canvas}: ${s.expect}`, () => {
      expect(judge(s).verdict).toBe(s.expect);
    });
  }
  it('#11: the bleeding hero is flagged at its content edge (x168), not its padding box', () => {
    const v = judge(seed('11'));
    const hero = v.offsets.find((o) => o.block === 'div:1>div:1 "This week"');
    expect(hero?.at).toBe(168);
    expect((hero as EdgeOffsetV3 | undefined)?.from).toBe('content');
  });
  it("#17: the plan Cards paint nothing (their hairline opens no door) and the evidence says so, with v2's reason", () => {
    const v = judge(seed('17'));
    expect(v.evidence).toContain('(v2: border; paints nothing: border 1.16:1 / ΔE 6.5; fill 1.00:1 / ΔE 0.0)');
    expect(Math.max(...v.offsets.map((o) => o.offPx))).toBe(25);
  });
  it('#23: the ghost back button paints by its shadow, so its box owns its edge', () => {
    const probe = parseEdgeProbeV3(seed('23').read);
    const back = probe!.blocks.find((b) => b.id.endsWith('"All plans" [controls]'));
    expect(back?.edgeIs).toBe('box');
    expect(back?.paint).toMatch(/^paints by shadow/);
    // The shadow door reads a peak; its geometry rides with it so the peak can be judged against the pixel later.
    expect(back?.paint).toContain('(peak; 0px 0px 4px 0px)');
  });
});

const block = (b: Partial<EdgeBlockV3> & Pick<EdgeBlockV3, 'id' | 'kind' | 'edge' | 'left' | 'right' | 'top' | 'bottom'>): EdgeBlockV3 => ({ edgeIs: 'box', ...b });
const card = { left: 0, right: 816 };

describe('space.edge.v3 synthetic seeds (#1765)', () => {
  it('change 2: an off block is off by its NEAREST edge (an arrow at 160 against 152), and the evidence names it', () => {
    const v = judgeEdgesV3(
      [
        block({ id: 'title', kind: 'text', edge: 152, edgeIs: 'first character', left: 152, right: 500, top: 20, bottom: 44 }),
        block({ id: 'back', kind: 'controls', edge: 192, edgeIs: 'first character', textEdge: 160, textEdgeIs: 'icon', left: 152, right: 260, top: 60, bottom: 90 }),
        block({ id: 'body', kind: 'text', edge: 152, edgeIs: 'first character', left: 152, right: 600, top: 100, bottom: 140 }),
      ],
      { cardContent: card },
    );
    expect(v.verdict).toBe('fail');
    expect(v.offsets).toHaveLength(1);
    expect(v.offsets[0]!.offPx).toBe(8);
    expect(v.evidence).toContain('back at x160 (its icon) is 8 px from x152');
  });
  it('change 1: a bleed whose title sits inside a centred column is judged by the title, against the body', () => {
    const v = judgeEdgesV3(
      [
        block({ id: 'band', kind: 'surface', edge: 0, left: 0, right: 816, top: 0, bottom: 80, contentLeft: 24, contentRight: 792, paint: 'paints by fill (ratio and ΔE): fill 9.00:1 / ΔE 60.0' }),
        block({ id: 'band title', kind: 'text', edge: 168, edgeIs: 'first character', left: 168, right: 400, top: 24, bottom: 56, within: 'band' }),
        block({ id: 'board heading', kind: 'text', edge: 24, edgeIs: 'first character', left: 24, right: 200, top: 100, bottom: 120 }),
        block({ id: 'board card', kind: 'text', edge: 24, edgeIs: 'first character', left: 24, right: 260, top: 130, bottom: 160 }),
      ],
      { cardContent: card },
    );
    expect(v.verdict).toBe('fail');
    expect(v.offsets.find((o) => o.block === 'band')?.offPx).toBe(144);
  });
  it('change 1: a bleed with no non-centred text keeps its padding box', () => {
    const v = judgeEdgesV3(
      [
        block({ id: 'band', kind: 'surface', edge: 0, left: 0, right: 816, top: 0, bottom: 80, contentLeft: 24, contentRight: 792 }),
        block({ id: 'band title', kind: 'text', edge: 300, edgeIs: 'first character', left: 300, right: 516, top: 24, bottom: 56, within: 'band', role: 'centred' }),
        block({ id: 'board heading', kind: 'text', edge: 24, edgeIs: 'first character', left: 24, right: 200, top: 100, bottom: 120 }),
        block({ id: 'board card', kind: 'text', edge: 24, edgeIs: 'first character', left: 24, right: 260, top: 130, bottom: 160 }),
      ],
      { cardContent: card },
    );
    expect(v.verdict).toBe('pass');
  });
  it('the typed read refuses a block that does not say what its edge is', () => {
    const read = (b: object) => parseEdgeProbeV3({ blocks: [b], unpainted: [], cardContent: { left: 0, right: 816 }, placeholdersOnly: false, skipped: { rowItems: 0, ornaments: 0 } });
    const ok = { id: 'a', kind: 'text', edge: 0, edgeIs: 'first character', left: 0, right: 10, top: 0, bottom: 10 };
    expect(read(ok)).not.toBeNull();
    expect(read({ ...ok, edgeIs: undefined })).toBeNull();
    expect(read({ ...ok, edgeIs: 'border' })).toBeNull();
  });
});
