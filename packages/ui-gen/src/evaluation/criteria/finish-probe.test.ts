import { describe, expect, it } from 'vitest';
import { FINISH_PROBE_EXPRESSION, FINISH_PROBE_VERSION, parseFinishProbe } from './finish-probe.js';

/**
 * ggui#1440 — the probe's typed read. The expression runs in the capture's real browser; here only what the page hands
 * back is checked, so a failed measurement is never read as a clean card.
 */
const ok = {
  version: FINISH_PROBE_VERSION,
  card: { width: 384, height: 516 },
  hero: { width: 384, height: 120, background: [41, 41, 41, 1], flat: true, firstChild: true },
  heroGround: [41, 41, 41, 1],
  texts: [
    { tag: 'h3', sample: 'Hello', color: [244, 243, 237, 1], backgrounds: [[41, 41, 41, 1]], composite: true, fontSize: 24, fontWeight: 600, heading: true, control: false, lines: 1 },
  ],
  paints: [
    { kind: 'fill', color: [41, 41, 41, 1], area: 46080, inHero: true, control: false, behind: [] },
    { kind: 'fill', color: [41, 41, 41, 1], area: 1200, inHero: false, control: true, behind: [[255, 255, 255, 1]] },
  ],
};

describe('parseFinishProbe', () => {
  it('reads a well-formed probe', () => {
    const p = parseFinishProbe(ok);
    expect(p?.version).toBe('finish-probe-v1');
    expect(p?.texts).toHaveLength(1);
    expect(p?.paints[1]).toEqual({ kind: 'fill', color: [41, 41, 41, 1], area: 1200, inHero: false, control: true, behind: [[255, 255, 255, 1]] });
    expect(p?.hero).toEqual({ width: 384, height: 120, background: [41, 41, 41, 1], flat: true, firstChild: true });
  });
  it('a card with no hero and an unresolvable token reads both as null, not as a failure', () => {
    const p = parseFinishProbe({ ...ok, hero: null, heroGround: null });
    expect(p).not.toBeNull();
    expect(p?.hero).toBeNull();
    expect(p?.heroGround).toBeNull();
  });
  it('a page with no #root (null), another version, or any other shape is unmeasured, never empty', () => {
    expect(parseFinishProbe(null)).toBeNull();
    expect(parseFinishProbe(500)).toBeNull();
    expect(parseFinishProbe({ ...ok, version: 'finish-probe-v0' })).toBeNull();
    expect(parseFinishProbe({ ...ok, texts: undefined })).toBeNull();
  });
  it('one malformed text, paint, colour or hero fails the whole read', () => {
    expect(parseFinishProbe({ ...ok, texts: [{ ...ok.texts[0], fontSize: Number.NaN }] })).toBeNull();
    expect(parseFinishProbe({ ...ok, texts: [{ ...ok.texts[0], backgrounds: [[0, 0, 0]] }] })).toBeNull();
    expect(parseFinishProbe({ ...ok, paints: [{ ...ok.paints[0], kind: 'text' }] })).toBeNull();
    expect(parseFinishProbe({ ...ok, paints: [{ ...ok.paints[0], control: undefined }] })).toBeNull();
    expect(parseFinishProbe({ ...ok, paints: [{ ...ok.paints[1], behind: [null] }] })).toBeNull();
    expect(parseFinishProbe({ ...ok, heroGround: 'var(--x)' })).toBeNull();
    expect(parseFinishProbe({ ...ok, hero: { ...ok.hero, flat: 'yes' } })).toBeNull();
  });
});

describe('FINISH_PROBE_EXPRESSION', () => {
  it('is plain page JavaScript that parses: no template literals, reading only under #root, bounded', () => {
    expect(FINISH_PROBE_EXPRESSION).not.toContain('`');
    expect(() => new Function(`return ${FINISH_PROBE_EXPRESSION};`)).not.toThrow();
    expect(FINISH_PROBE_EXPRESSION).toContain("document.getElementById('root')");
    expect(FINISH_PROBE_EXPRESSION).toContain('visited.length < 400');
  });
  it('stamps the version the parser accepts, and reads the decided inputs', () => {
    expect(FINISH_PROBE_EXPRESSION).toContain(`version: '${FINISH_PROBE_VERSION}'`);
    expect(FINISH_PROBE_EXPRESSION).toContain("resolveVar('--ggui-color-heroGround')");
    expect(FINISH_PROBE_EXPRESSION).toContain('[data-ggui-surface="hero"]');
    // An overlap at the run's centre makes its background uncertain, never a number.
    expect(FINISH_PROBE_EXPRESSION).toContain('document.elementFromPoint(cx, cy)');
    expect(FINISH_PROBE_EXPRESSION).toContain("as.backgroundImage !== 'none' || parseFloat(as.opacity) < 1 || as.mixBlendMode !== 'normal'");
    // Any CSS colour syntax a computed style can serialize (oklch, color(), a resolved color-mix) reads through a canvas.
    expect(FINISH_PROBE_EXPRESSION).toContain("if (!m) return viaCanvas(c);");
    // A translucent band is not flat; a line count excludes vertical padding and borders.
    expect(FINISH_PROBE_EXPRESSION).toContain('hbg !== null && hbg[3] >= 1');
    expect(FINISH_PROBE_EXPRESSION).toContain('Math.round((r.height - edges) / lineHeight)');
  });
});
