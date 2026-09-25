import { describe, expect, it } from 'vitest';
import { WORDMARK_SHAPES, WORDMARK_VIEWBOX, wordmarkSvg } from './wordmark.js';

describe('wordmark geometry', () => {
  it('is the canonical four-glyph construction, byte for byte', () => {
    expect(WORDMARK_VIEWBOX).toEqual({ width: 224, height: 50 });
    expect(WORDMARK_SHAPES).toEqual([
      { kind: 'path', d: 'M 0 0 H 50 V 25 H 25 V 50 H 0 Z', tone: 'chrome' },
      { kind: 'rect', x: 33, y: 33, width: 17, height: 17, tone: 'ink' },
      { kind: 'path', d: 'M 58 0 H 108 V 25 H 83 V 50 H 58 Z', tone: 'ink' },
      { kind: 'rect', x: 91, y: 33, width: 17, height: 17, tone: 'chrome' },
      {
        kind: 'path',
        d: 'M 141 50 C 154.807 50 166 38.8071 166 25 V 0 H 116 V 25 C 116 38.8071 127.193 50 141 50 Z',
        tone: 'ink',
      },
      { kind: 'rect', x: 174, y: 0, width: 50, height: 50, tone: 'chrome' },
    ]);
  });

  it('renders as an SVG document at scale, chrome and ink filled', () => {
    const svg = wordmarkSvg({ width: 448 });
    expect(svg).toContain('viewBox="0 0 224 50"');
    expect(svg).toContain('width="448" height="100"');
    expect(svg).toContain('<path d="M 0 0 H 50 V 25 H 25 V 50 H 0 Z" fill="#D9D9D9"/>');
    expect(svg).toContain('<rect x="174" y="0" width="50" height="50" fill="#D9D9D9"/>');
    expect(svg).toContain('<rect x="33" y="33" width="17" height="17" fill="#292929"/>');
  });
});
