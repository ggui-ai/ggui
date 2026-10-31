import { describe, expect, it } from 'vitest';
import { EDGE_BLOCKS_V3_EXPRESSION } from './edge-probe-v3.js';

/**
 * #1765 — v3's shadow door reads a NON-INSET shadow layer only (an inset shadow paints inside the box, so it draws no
 * edge). The expression runs in a real browser, so here its `shadowColour` is lifted verbatim from the expression
 * text and called directly: a regex whose `\b` was written as a literal backspace byte (U+0008) can never match
 * "inset", which silently counts every inset shadow as paint.
 */
const MARK = 'const shadowColour = ';

function liftShadowColour(): (layer: string) => { colour: string; geo: string } | null {
  const line = EDGE_BLOCKS_V3_EXPRESSION.split('\n').find((l) => l.includes(MARK));
  if (line === undefined) throw new Error('edge-probe-v3: shadowColour not found in the expression');
  const source = line.slice(line.indexOf(MARK) + MARK.length).replace(/;\s*$/, '');
  return new Function(`return (${source});`)() as (layer: string) => { colour: string; geo: string } | null;
}

describe('space.edge.v3 shadow door skips inset shadows (#1765)', () => {
  const shadowColour = liftShadowColour();

  it('an inset layer opens no door, at either end of the layer', () => {
    expect(shadowColour('rgba(0, 0, 0, 0.05) 0px 2px 4px 0px inset')).toBeNull();
    expect(shadowColour('inset 0px 2px 4px 0px rgba(0, 0, 0, 0.05)')).toBeNull();
  });

  it('control: a drop shadow is read, with its colour and geometry', () => {
    expect(shadowColour('rgba(0, 0, 0, 0.05) 0px 1px 2px 0px')).toEqual({
      colour: 'rgba(0, 0, 0, 0.05)',
      geo: '0px 1px 2px 0px',
    });
  });

  it('the expression carries no control byte (a `\\b` must reach the page as two characters)', () => {
    const control = [...EDGE_BLOCKS_V3_EXPRESSION].filter((c) => {
      const code = c.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    });
    expect(control).toEqual([]);
  });
});
