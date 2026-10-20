// #1765 — `space.edge.v2`'s seeds. The nine cards the design lead judged by eye on draw 2 (c.6262928843, as ruled in
// c.6282971546), read by the v2 probe at both widths, and the synthetic seeds the registration names. v1 (`edge.ts`)
// is a separate, frozen instrument and is not touched here.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEdgeProbeV2 } from './edge-probe-v2.js';
import { judgeEdgesV2, type EdgeBlockV2 } from './edge-v2.js';

const here = dirname(fileURLToPath(import.meta.url));
interface FixtureRead {
  readonly width: number;
  readonly expect: 'pass' | 'fail';
  readonly cardContent: { readonly left: number; readonly right: number };
  readonly placeholdersOnly: boolean;
  readonly blocks: unknown;
}
interface Fixture {
  readonly cards: Readonly<Record<string, { readonly eye: 'legal' | 'split'; readonly reads: readonly FixtureRead[] }>>;
}
const fixture: Fixture = JSON.parse(readFileSync(resolve(here, '__fixtures__/edge-v2-draw2.json'), 'utf8'));

describe('space.edge.v2 on draw 2: agreement with the eye on every validation card (#1765)', () => {
  for (const [card, { eye, reads }] of Object.entries(fixture.cards)) {
    for (const r of reads) {
      it(`card ${card} (${eye}) at ${r.width}: ${r.expect}`, () => {
        // The stored read goes through the probe's own typed read, so a fixture the parser refuses fails here.
        const probe = parseEdgeProbeV2({ blocks: r.blocks, cardContent: r.cardContent, placeholdersOnly: r.placeholdersOnly, skipped: { rowItems: 0, ornaments: 0 } });
        expect(probe).not.toBeNull();
        expect(judgeEdgesV2(probe!.blocks, { cardContent: probe!.cardContent }).verdict).toBe(r.expect);
      });
    }
    it(`card ${card}: the card verdict is the eye's`, () => {
      const verdicts = reads.map((r) => {
        const probe = parseEdgeProbeV2({ blocks: r.blocks, cardContent: r.cardContent, placeholdersOnly: r.placeholdersOnly, skipped: { rowItems: 0, ornaments: 0 } });
        return judgeEdgesV2(probe!.blocks, { cardContent: probe!.cardContent }).verdict;
      });
      expect(verdicts.includes('fail') ? 'split' : 'legal').toBe(eye);
    });
  }
});

const block = (b: Partial<EdgeBlockV2> & Pick<EdgeBlockV2, 'id' | 'kind' | 'edge' | 'left' | 'right' | 'top' | 'bottom'>): EdgeBlockV2 => b;
const card = { left: 0, right: 384 };

describe('space.edge.v2 synthetic seeds (#1765)', () => {
  it("12@418 on the old judge page: a bleed's content at x24 and the body at x0 is a split", () => {
    const v = judgeEdgesV2(
      [
        block({ id: 'band', kind: 'surface', edge: 0, left: 0, right: 384, top: 0, bottom: 80, contentLeft: 24, contentRight: 360 }),
        block({ id: 'band title', kind: 'text', edge: 24, left: 24, right: 200, top: 24, bottom: 48, within: 'band' }),
        block({ id: 'body', kind: 'text', edge: 0, left: 0, right: 300, top: 100, bottom: 140 }),
        block({ id: 'more', kind: 'text', edge: 0, left: 0, right: 280, top: 150, bottom: 180 }),
      ],
      { cardContent: card },
    );
    expect(v.verdict).toBe('fail');
  });
  it('a trailing block alone on its line that ends mid-card is a split', () => {
    const v = judgeEdgesV2(
      [
        block({ id: 'title', kind: 'text', edge: 24, left: 24, right: 200, top: 20, bottom: 50 }),
        block({ id: 'stray', kind: 'text', edge: 180, left: 180, right: 260, top: 60, bottom: 80, parentRight: 360 }),
        block({ id: 'body', kind: 'text', edge: 24, left: 24, right: 340, top: 90, bottom: 140 }),
      ],
      { cardContent: { left: 24, right: 360 } },
    );
    expect(v.verdict).toBe('fail');
  });
  it("a badge that ends on its box's right content edge is right-anchored, and legal", () => {
    const v = judgeEdgesV2(
      [
        block({ id: 'badge', kind: 'text', edge: 300, left: 300, right: 336, top: 20, bottom: 36, parentRight: 336 }),
        block({ id: 'title', kind: 'text', edge: 48, left: 48, right: 290, top: 50, bottom: 90 }),
        block({ id: 'body', kind: 'text', edge: 48, left: 48, right: 330, top: 100, bottom: 140 }),
      ],
      { cardContent: { left: 24, right: 360 } },
    );
    expect(v.verdict).toBe('pass');
  });
  it('a row item after a painted leader is measured with its own item, never against the column', () => {
    const v = judgeEdgesV2(
      [
        block({ id: 'icon', kind: 'media', edge: 24, left: 24, right: 48, top: 20, bottom: 44 }),
        block({ id: 'title', kind: 'text', edge: 64, left: 64, right: 300, top: 16, bottom: 48, follows: 'icon', item: 'stack' }),
        block({ id: 'subtitle', kind: 'text', edge: 64, left: 64, right: 200, top: 50, bottom: 66, follows: 'icon', item: 'stack' }),
        block({ id: 'body', kind: 'text', edge: 24, left: 24, right: 340, top: 90, bottom: 140 }),
      ],
      { cardContent: { left: 24, right: 360 } },
    );
    expect(v.verdict).toBe('pass');
    // The same title and subtitle with no leader stand in the column, 40 px off it.
    const alone = judgeEdgesV2(
      [
        block({ id: 'title', kind: 'text', edge: 64, left: 64, right: 300, top: 16, bottom: 48 }),
        block({ id: 'subtitle', kind: 'text', edge: 64, left: 64, right: 200, top: 50, bottom: 66 }),
        block({ id: 'body', kind: 'text', edge: 24, left: 24, right: 340, top: 90, bottom: 140 }),
      ],
      { cardContent: { left: 24, right: 360 } },
    );
    expect(alone.verdict).toBe('fail');
  });
});
