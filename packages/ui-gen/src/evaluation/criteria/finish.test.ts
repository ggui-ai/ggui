import { describe, expect, it } from 'vitest';
import type { FinishPaint, FinishProbe, FinishText, Rgba } from './finish-probe.js';
import { FINISH_READS, contrastRatio, deltaE76, effectiveBackground, over, readContrast, readField, readGesture, readOneColour } from './finish.js';

/**
 * ggui#1440 — the finish instruments as pure reads over a typed probe. The numbers are the bank rows' own, and the
 * contrast fixtures are the criteria bank's own recorded figures (the hello's trap), reproduced here before any capture.
 */
const WHITE: Rgba = [255, 255, 255, 1];
const CREAM: Rgba = [244, 243, 237, 1];
const INK: Rgba = [41, 41, 41, 1];
const PRIMARY_500: Rgba = [228, 84, 23, 1];
const ON_PRIMARY: Rgba = [20, 25, 20, 1];
const withAlpha = (c: Rgba, a: number): Rgba => [c[0], c[1], c[2], a];

const text = (patch: Partial<FinishText> = {}): FinishText => ({
  tag: 'p', sample: 'Welcome', color: INK, backgrounds: [WHITE], composite: true,
  fontSize: 16, fontWeight: 400, heading: false, control: false, lines: 1, ...patch,
});
const paint = (patch: Partial<FinishPaint> = {}): FinishPaint => ({ kind: 'fill', color: INK, area: 0, inHero: false, control: false, behind: [], ...patch });
/** A 384×516 card (198,144 px²) with an ink band of 384×120 (23.3 %) whose ground is the resolved token. */
const probe = (patch: Partial<FinishProbe> = {}): FinishProbe => ({
  version: 'finish-probe-v1',
  card: { width: 384, height: 516 },
  hero: { width: 384, height: 120, background: INK, flat: true, firstChild: true },
  heroGround: INK,
  texts: [text({ tag: 'h3', sample: 'Hello', heading: true, fontSize: 24, fontWeight: 600, color: CREAM, backgrounds: [INK] }), text()],
  paints: [paint({ color: INK, area: 384 * 120, inHero: true })],
  ...patch,
});

describe('the colour arithmetic', () => {
  it("reproduces the bank's recorded figures: dark on primary-500 is 4.73:1 at full opacity, 4.38:1 at .92, 4.04:1 at .85", () => {
    const at = (a: number): number => contrastRatio(over(withAlpha(ON_PRIMARY, a), PRIMARY_500), PRIMARY_500);
    expect(at(1).toFixed(2)).toBe('4.73');
    expect(at(0.92).toFixed(2)).toBe('4.38');
    expect(at(0.85).toFixed(2)).toBe('4.04');
  });
  it('composites a translucent stack nearest-first, over white when nothing is opaque', () => {
    expect(effectiveBackground([])).toEqual(WHITE);
    expect(effectiveBackground([[0, 0, 0, 0.5]])).toEqual([128, 128, 128, 1]);
    expect(effectiveBackground([[0, 0, 0, 0.5], INK])).toEqual([21, 21, 21, 1]);
  });
  it('ΔE76 is zero on the same colour and large across hues', () => {
    expect(deltaE76(INK, INK)).toBe(0);
    expect(deltaE76(PRIMARY_500, [23, 84, 228, 1])).toBeGreaterThan(50);
  });
});

describe('read.contrast', () => {
  it('passes the built-in pair and names the worst run', () => {
    const r = readContrast(probe());
    expect(r.verdict).toBe('pass');
    expect(r.evidence).toContain('every text meets AA');
    expect(r).not.toHaveProperty('notEvaluated');
  });
  it('fails body text on primary-500 at opacity .92 (4.38:1 < 4.5), naming it', () => {
    const r = readContrast(probe({ texts: [text({ sample: 'Your plan', color: withAlpha(ON_PRIMARY, 0.92), backgrounds: [PRIMARY_500] })] }));
    expect(r.verdict).toBe('fail');
    expect(r.evidence).toContain('p "Your plan" 4.38:1 against 4.5:1');
  });
  it('large text reads against 3:1 — 24 px, or 19 px bold', () => {
    const orange: Rgba = [214, 110, 40, 1];
    const at = (fontSize: number, fontWeight: number) => readContrast(probe({ texts: [text({ color: orange, backgrounds: [CREAM], fontSize, fontWeight })] })).verdict;
    expect(contrastRatio(orange, CREAM)).toBeGreaterThan(3);
    expect(contrastRatio(orange, CREAM)).toBeLessThan(4.5);
    expect(at(16, 400)).toBe('fail');
    expect(at(24, 400)).toBe('pass');
    expect(at(19, 700)).toBe('pass');
    expect(at(19, 600)).toBe('fail');
  });
  it('a text on a background that is not flat colour is never given a number: not evaluated, not-flat', () => {
    const r = readContrast(probe({ texts: [text(), text({ composite: false })] }));
    expect(r).toMatchObject({ verdict: 'n/a', notEvaluated: { reason: 'not-flat' } });
    expect(r.evidence).toContain('1 of 2 texts');
  });
  it('a certain failure still fails beside an uncertain run', () => {
    const r = readContrast(probe({ texts: [text({ composite: false }), text({ color: [200, 200, 200, 1] })] }));
    expect(r.verdict).toBe('fail');
  });
  it('no text is not applicable', () => {
    expect(readContrast(probe({ texts: [] }))).toEqual({ verdict: 'n/a', evidence: 'no text on the card' });
  });
});

describe('hello.field', () => {
  it("passes the unthemed hello: the band is the resolved hero ground at 23 % of the card", () => {
    expect(readField(probe())).toEqual({ verdict: 'pass', evidence: 'band #292929 vs hero ground #292929, covering 23.3 % of the card' });
  });
  it('fails a band in another colour, and a band below 8 %', () => {
    expect(readField(probe({ hero: { width: 384, height: 120, background: PRIMARY_500, flat: true, firstChild: true } })).verdict).toBe('fail');
    expect(readField(probe({ hero: { width: 384, height: 30, background: INK, flat: true, firstChild: true } })).verdict).toBe('fail');
  });
  it('no hero surface fails; a non-flat band and an unresolved token are not evaluated, each with its reason', () => {
    expect(readField(probe({ hero: null })).verdict).toBe('fail');
    expect(readField(probe({ hero: { width: 384, height: 120, background: INK, flat: false, firstChild: true } }))).toMatchObject({ verdict: 'n/a', notEvaluated: { reason: 'not-flat' } });
    expect(readField(probe({ heroGround: null }))).toMatchObject({ verdict: 'n/a', notEvaluated: { reason: 'unresolved-token' } });
  });
});

describe('hello.one-colour', () => {
  const area = 384 * 516;
  it('passes the 10-20.5 hello: an ink band, outline chips in neutral borders, no filled control', () => {
    const chips = [1, 2, 3].map(() => paint({ kind: 'border', color: [200, 200, 200, 1], area: 2 * 120 }));
    const r = readOneColour(probe({ paints: [paint({ color: INK, area: 384 * 120, inHero: true }), ...chips] }));
    expect(r).toEqual({ verdict: 'pass', evidence: 'the band (#292929) is the only fill; no filled control and no saturated paint outside it' });
  });
  it('under an achromatic band a saturated paint is far by ΔE76 and fails, named an invented accent', () => {
    const r = readOneColour(probe({ paints: [paint({ color: PRIMARY_500, area: 0.03 * area })] }));
    expect(r.verdict).toBe('fail');
    expect(r.evidence).toContain('an achromatic band (#292929)');
  });
  it("at the threshold edge a paint within ΔE76 5 of a muted band is the band's own colour, not an accent: pass", () => {
    const muted: Rgba = [200, 140, 88, 1];
    const near: Rgba = [204, 140, 82, 1];
    expect(deltaE76(muted, near)).toBeLessThan(5);
    const r = readOneColour(probe({ hero: { width: 384, height: 120, background: muted, flat: true, firstChild: true }, paints: [paint({ kind: 'border', color: near, area: 240 })] }));
    expect(r.verdict).toBe('pass');
  });
  it('under an achromatic band one 1 px teal chip border fails: the floor is relative, so it weighs against itself', () => {
    const teal: Rgba = [0, 150, 136, 1];
    expect(readOneColour(probe({ paints: [paint({ kind: 'border', color: teal, area: 1 * 100 })] })).verdict).toBe('fail');
  });
  it("the floor is 2 % of the largest saturated paint outside the band, never of the card: the teal-chip control fails", () => {
    // An orange band with outline chips: two chips bordered in the band's orange, one in teal. Each 1 px border is
    // ~0.1 % of the card, so a card-relative floor would never weigh it; against its peers the teal one counts.
    const band = { width: 384, height: 120, background: PRIMARY_500, flat: true, firstChild: true };
    const chip = (color: Rgba) => paint({ kind: 'border', color, area: 2 * 120 });
    const teal = readOneColour(probe({ hero: band, paints: [chip(PRIMARY_500), chip(PRIMARY_500), chip([0, 150, 136, 1])] }));
    expect(teal.verdict).toBe('fail');
    expect(teal.evidence).toContain('#009688 outside the band is ΔE76');
    // Below 2 % of the largest saturated paint, a stray hue is not populous.
    const stray = readOneColour(probe({ hero: band, paints: [paint({ kind: 'border', color: PRIMARY_500, area: 0.05 * area }), paint({ kind: 'border', color: [23, 84, 228, 1], area: 0.0005 * area })] }));
    expect(stray.verdict).toBe('pass');
  });
  it('under a chromatic band, the same colour passes and another hue fails', () => {
    const band = { width: 384, height: 120, background: PRIMARY_500, flat: true, firstChild: true };
    const border = (color: Rgba) => paint({ kind: 'border', color, area: 0.03 * area });
    expect(readOneColour(probe({ hero: band, paints: [border(PRIMARY_500)] })).verdict).toBe('pass');
    expect(readOneColour(probe({ hero: band, paints: [border([23, 84, 228, 1])] })).verdict).toBe('fail');
  });
  it('a filled control must be the band ground; an outline control (its fill is the surface behind it) is no filled control', () => {
    const control = (color: Rgba) => paint({ color, area: 0.005 * area, control: true, behind: [WHITE] });
    expect(readOneColour(probe({ paints: [control(INK)] })).verdict).toBe('pass');
    expect(readOneColour(probe({ paints: [control(WHITE)] })).verdict).toBe('pass');
    const grey = readOneColour(probe({ paints: [control([85, 85, 85, 1])] }));
    expect(grey.verdict).toBe('fail');
    expect(grey.evidence).toContain('a filled control in #555555');
  });
  it('no flat band to compare against is not evaluated', () => {
    expect(readOneColour(probe({ hero: null }))).toMatchObject({ verdict: 'n/a', notEvaluated: { reason: 'not-flat' } });
    // A gradient band reports a transparent background colour; it is never compared as white.
    const gradient = readOneColour(probe({ hero: { width: 384, height: 120, background: [0, 0, 0, 0], flat: false, firstChild: true } }));
    expect(gradient).toMatchObject({ verdict: 'n/a', notEvaluated: { reason: 'not-flat' } });
  });
});

describe('hello.gesture', () => {
  it("passes the brief's heading: Heading level 3, 24 px over base 16 px = 1.5×, one line", () => {
    expect(readGesture(probe())).toEqual({ verdict: 'pass', evidence: 'heading 24px over body 16px (p "Welcome") = 1.50×, 1 line' });
  });
  it('fails below 1.5×, over two lines, and a second loud text', () => {
    const h = (patch: Partial<FinishText>) => text({ tag: 'h3', heading: true, fontSize: 24, ...patch });
    expect(readGesture(probe({ texts: [h({ fontSize: 20 }), text()] })).verdict).toBe('fail');
    expect(readGesture(probe({ texts: [h({ lines: 3 }), text()] })).verdict).toBe('fail');
    const two = readGesture(probe({ texts: [h({}), text(), h({ tag: 'h4', sample: 'Plans' })] }));
    expect(two.verdict).toBe('fail');
    expect(two.evidence).toContain('h4 "Plans" also reaches the heading\'s step: not exactly one typographic event');
    // A non-heading as loud as the heading is the body the heading is measured against, and the evidence names it.
    const stat = readGesture(probe({ texts: [h({}), text(), text({ tag: 'span', sample: '$42', fontSize: 28 })] }));
    expect(stat.verdict).toBe('fail');
    expect(stat.evidence).toContain('over body 28px (span "$42") = 0.86×');
  });
  it("a control's label is not the body the heading is measured against", () => {
    const r = readGesture(probe({ texts: [text({ tag: 'h3', heading: true, fontSize: 24 }), text(), text({ tag: 'button', control: true, fontSize: 18 })] }));
    expect(r.verdict).toBe('pass');
  });
  it('no heading fails; no body is not applicable', () => {
    expect(readGesture(probe({ texts: [text()] })).verdict).toBe('fail');
    expect(readGesture(probe({ texts: [text({ heading: true })] })).verdict).toBe('n/a');
  });
});

describe('FINISH_READS', () => {
  it('answers exactly the four rows the bank flips live', () => {
    expect(Object.keys(FINISH_READS).sort()).toEqual(['hello.field', 'hello.gesture', 'hello.one-colour', 'read.contrast']);
  });
});
