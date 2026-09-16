import { describe, expect, it } from 'vitest';
import {
  APP_THEME_FONTS_MAX,
  appThemeImagerySchema,
  appThemeReadSchema,
  appThemeRefusalBodySchema,
  appThemeSchema,
  fontFaceDeclarationSchema,
  parseAppThemeAtReadDoor,
  type AppTheme,
  appThemeDroppedMembers,
  appThemeWouldDropRefusalText,
  appThemeCarrySchema,
  appThemeGetResponseSchema,
} from './app-theme.js';
import { canonicalOverlayJson } from '../integrations/overlay-hash.js';

const HASH = 'a'.repeat(64);

/**
 * ggui#987 — the overlay is the projection: both modes REQUIRED, the
 * attestation REQUIRED, `mode` a default only, `name` a label, `base` gone.
 * The one-palette v1 wire is refused at the schema — no adapter branch.
 */
describe('appThemeSchema (v2, ggui#987)', () => {
  const valid: AppTheme = {
    overlayHash: HASH,
    overlays: {
      light: { '--ggui-color-primary-600': '#7c3aed', '--ggui-shape-radius-md': '12px' },
      dark: { '--ggui-color-primary-600': '#a78bfa', '--ggui-shape-radius-md': '12px' },
    },
    name: 'ocean',
    mode: 'dark',
  };

  it('accepts a well-formed two-mode overlay with its attestation', () => {
    expect(appThemeSchema.parse(valid)).toEqual(valid);
  });

  it('accepts without name and without mode (mode-neutral: the host announce fills it)', () => {
    const { name: _n, mode: _m, ...neutral } = valid;
    expect(appThemeSchema.parse(neutral)).toEqual(neutral);
  });

  it('REFUSES the v1 one-palette wire (mode + cssVariables, no overlays)', () => {
    expect(appThemeSchema.safeParse({ mode: 'light', cssVariables: { '--ggui-color-primary-500': '#3355ff' } }).success).toBe(false);
  });

  it('REFUSES a `base` ladder — the registration tier is gone (D2 = B)', () => {
    expect(
      appThemeSchema.safeParse({
        ...valid,
        base: { documentHash: HASH, light: {}, dark: {} },
      }).success,
    ).toBe(false);
  });

  it('REFUSES an overlay missing either mode', () => {
    expect(appThemeSchema.safeParse({ ...valid, overlays: { light: valid.overlays.light } }).success).toBe(false);
    expect(appThemeSchema.safeParse({ ...valid, overlays: { dark: valid.overlays.dark } }).success).toBe(false);
  });

  it('REFUSES a missing or malformed overlayHash', () => {
    const { overlayHash: _h, ...noHash } = valid;
    expect(appThemeSchema.safeParse(noHash).success).toBe(false);
    expect(appThemeSchema.safeParse({ ...valid, overlayHash: 'ABC' }).success).toBe(false);
  });

  it('accepts mode-agnostic cssVariables on top of both projections', () => {
    const withVars = { ...valid, cssVariables: { '--ggui-shape-radius-md': '4px' } };
    expect(appThemeSchema.parse(withVars)).toEqual(withVars);
  });

  it('rejects a non-ggui css-var key in any map', () => {
    expect(appThemeSchema.safeParse({ ...valid, cssVariables: { '--evil-x': 'red' } }).success).toBe(false);
    expect(appThemeSchema.safeParse({ ...valid, overlays: { ...valid.overlays, light: { '--evil-x': 'red' } } }).success).toBe(false);
  });

  it('rejects an injection value (CSS rule breakout) in a projection', () => {
    expect(
      appThemeSchema.safeParse({
        ...valid,
        overlays: { ...valid.overlays, dark: { '--ggui-color-primary-600': 'red; } :root { background: url(x) }' } },
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid mode', () => {
    expect(appThemeSchema.safeParse({ ...valid, mode: 'sepia' }).success).toBe(false);
  });

  it('accepts per-mode keyframes and frameless; rejects oversized keyframes', () => {
    const kf = { ...valid, keyframes: { light: '@keyframes a{}', dark: '@keyframes b{}' }, frameless: true };
    expect(appThemeSchema.parse(kf)).toEqual(kf);
    expect(appThemeSchema.safeParse({ ...valid, keyframes: { light: 'x'.repeat(8193) } }).success).toBe(false);
  });

  it('stays strict — unknown fields rejected', () => {
    expect(appThemeSchema.safeParse({ ...valid, courts: {} }).success).toBe(false);
  });
});

describe('appThemeRefusalBodySchema — the one write-door refusal shape', () => {
  it('accepts exactly one of the four bodies', () => {
    for (const body of [
      { uncovered: { light: ['--ggui-color-outline'], dark: [] } },
      { unknown: { light: [], dark: ['--ggui-color-surface'] } },
      { overlayHash: 'mismatch' },
      { refused: 'v1 shape' },
    ]) expect(appThemeRefusalBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
  });
  it('refuses a body that names two reasons or an unknown one', () => {
    expect(appThemeRefusalBodySchema.safeParse({ overlayHash: 'mismatch', refused: 'v1 shape' }).success).toBe(false);
    expect(appThemeRefusalBodySchema.safeParse({ reason: 'x' }).success).toBe(false);
  });
});

// ggui#1093 belt (VERSION-POLICY §3.6, ruled with cloud 2026-09-15): WRITE doors
// validate with the strict schema and REFUSE an unknown top-level member; READ
// doors (a stored row, a carried render-meta slice) strip unknown TOP-LEVEL
// members, keep the overlays, and name what they stripped — so a reader on the
// previous release never drops a whole theme over a member a later release
// added. Token rules, nested strictness and the attestation are untouched.
describe('appThemeReadSchema + parseAppThemeAtReadDoor — the read-door posture (ggui#1093 belt)', () => {
  const valid: AppTheme = {
    overlayHash: HASH,
    overlays: {
      light: { '--ggui-color-primary-600': '#7c3aed' },
      dark: { '--ggui-color-primary-600': '#a78bfa' },
    },
    name: 'violet',
  };
  const later = { ...valid, futureMember: { any: 'shape' } };

  it('the WRITE schema still refuses an unknown top-level member', () => {
    expect(appThemeSchema.safeParse(later).success).toBe(false);
  });

  it('the READ schema strips an unknown top-level member and keeps the overlays byte-identical', () => {
    const r = appThemeReadSchema.safeParse(later);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(valid);
  });

  it('the read helper names the stripped members, in payload order, and reports none when nothing was stripped', () => {
    const r = parseAppThemeAtReadDoor({ ...later, anotherFutureMember: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.theme).toEqual(valid);
      expect(r.stripped).toEqual(['futureMember', 'anotherFutureMember']);
    }
    const clean = parseAppThemeAtReadDoor(valid);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.stripped).toEqual([]);
  });

  it('the read door still refuses what the write door refuses below the top level: a nested unknown key, a bad token, the v1 shape, a non-object', () => {
    const nested = parseAppThemeAtReadDoor({ ...valid, overlays: { ...valid.overlays, sepia: {} } });
    expect(nested.ok).toBe(false);
    const badToken = parseAppThemeAtReadDoor({ ...valid, overlays: { light: { color: '#fff' }, dark: {} } });
    expect(badToken.ok).toBe(false);
    if (!badToken.ok) expect(badToken.issues.some((i) => i.startsWith('overlays.light'))).toBe(true);
    expect(parseAppThemeAtReadDoor({ mode: 'light', cssVariables: {} }).ok).toBe(false);
    expect(parseAppThemeAtReadDoor('violet').ok).toBe(false);
  });
});

// ggui#1093 P1a — the host-design-language CARRIER, wire half (#1075 Track C (a), #990):
// `fonts?` (the document's `typography.faces` grammar, lifted — one schema, two
// doors) and `imagery?` (mark / hero / pattern, https-only, tone word). Grammar at
// the door, never fetched; the render host unions origins into CSP, the shell
// inlines the faces; neither is inside the attestation.
describe('AppTheme carrier — fonts + imagery (ggui#1093 P1a)', () => {
  const valid: AppTheme = {
    overlayHash: HASH,
    overlays: {
      light: { '--ggui-color-primary-600': '#7c3aed' },
      dark: { '--ggui-color-primary-600': '#a78bfa' },
    },
  };
  const face = { family: 'Neue Montreal', src: 'https://fonts.example/neue-montreal.woff2', weight: 500, style: 'normal', display: 'swap' };

  it('fontFaceDeclarationSchema is the document grammar, verbatim: one-line family, https src with a well-formed host, weight string|int 1..1000, style, display; strict', () => {
    expect(fontFaceDeclarationSchema.parse(face)).toEqual(face);
    expect(fontFaceDeclarationSchema.parse({ family: 'X', src: 'https://f.example/x.woff2', weight: 'bold' }).weight).toBe('bold');
    for (const bad of [
      { family: 'X', src: 'http://f.example/x.woff2' },
      { family: 'X', src: 'https://localhost/x.woff2' },
      { family: 'X', src: 'not a url' },
      { family: 'two\nlines', src: 'https://f.example/x.woff2' },
      { family: 'X', src: 'https://f.example/x.woff2', weight: 0 },
      { family: 'X', src: 'https://f.example/x.woff2', weight: 1001 },
      { family: 'X', src: 'https://f.example/x.woff2', unicodeRange: 'U+0000-00FF' },
      { src: 'https://f.example/x.woff2' },
    ]) {
      expect(fontFaceDeclarationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts `fonts` up to APP_THEME_FONTS_MAX faces; refuses an empty array, one over the max, and a face with a non-https src — naming the path', () => {
    expect(APP_THEME_FONTS_MAX).toBe(16);
    expect(appThemeSchema.parse({ ...valid, fonts: [face] })).toEqual({ ...valid, fonts: [face] });
    expect(appThemeSchema.safeParse({ ...valid, fonts: Array.from({ length: APP_THEME_FONTS_MAX }, () => face) }).success).toBe(true);
    expect(appThemeSchema.safeParse({ ...valid, fonts: [] }).success).toBe(false);
    expect(appThemeSchema.safeParse({ ...valid, fonts: Array.from({ length: APP_THEME_FONTS_MAX + 1 }, () => face) }).success).toBe(false);
    const bad = appThemeSchema.safeParse({ ...valid, fonts: [face, { family: 'Y', src: 'http://f.example/y.woff2' }] });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['fonts', 1, 'src']);
  });

  it('accepts `imagery` — mark / hero / pattern, each { src https, alt? ≤ 200, tone? light|dark }; refuses http, an unknown kind, an unknown key, a long alt, a tone outside the pair', () => {
    const imagery = {
      mark: { src: 'https://cdn.example/mark.svg', alt: 'Mosaic' },
      hero: { src: 'https://cdn.example/hero.jpg', tone: 'dark' },
      pattern: { src: 'https://cdn.example/pattern.png', tone: 'light' },
    };
    expect(appThemeImagerySchema.parse(imagery)).toEqual(imagery);
    expect(appThemeSchema.parse({ ...valid, imagery })).toEqual({ ...valid, imagery });
    expect(appThemeSchema.parse({ ...valid, imagery: { mark: { src: 'https://cdn.example/m.svg' } } }).imagery?.mark?.src).toBe('https://cdn.example/m.svg');
    for (const bad of [
      { mark: { src: 'http://cdn.example/mark.svg' } },
      { logo: { src: 'https://cdn.example/mark.svg' } },
      { mark: { src: 'https://cdn.example/mark.svg', width: 10 } },
      { mark: { src: 'https://cdn.example/mark.svg', alt: 'a'.repeat(201) } },
      { hero: { src: 'https://cdn.example/hero.jpg', tone: 'sepia' } },
      { mark: 'https://cdn.example/mark.svg' },
    ]) {
      expect(appThemeSchema.safeParse({ ...valid, imagery: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('the read door now NAMES fonts and imagery — kept, nothing stripped — and still strips a member no release names beside them', () => {
    const imagery = { mark: { src: 'https://cdn.example/mark.svg' } };
    const r = parseAppThemeAtReadDoor({ ...valid, fonts: [face], imagery, futureMember: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.theme).toEqual({ ...valid, fonts: [face], imagery });
      expect(r.stripped).toEqual(['futureMember']);
    }
    expect(appThemeReadSchema.parse({ ...valid, fonts: [face] })).toEqual({ ...valid, fonts: [face] });
  });

  it('fonts and imagery are OUTSIDE the attestation — the canonical overlay JSON is byte-identical with and without them', () => {
    const withAssets: AppTheme = { ...valid, fonts: [face], imagery: { mark: { src: 'https://cdn.example/mark.svg' } } };
    expect(canonicalOverlayJson(withAssets)).toBe(canonicalOverlayJson(valid));
  });
});

// ggui#1124 — the destructive-write rule. `putAppTheme` REPLACES the whole
// `theme` attribute, so a writer composing fewer members than the stored
// document destroys the rest (26 rows lost their theme outright on
// 2026-09-10; ~20 more lost members nobody can now name). The RULE lives
// here — what makes a write destructive is a fact about the wire shape, not
// about DynamoDB — and the shared writer enforces it at the choke point.
describe('appThemeDroppedMembers — what makes a theme write destructive (ggui#1124)', () => {
  const stored = {
    overlayHash: HASH,
    overlays: { light: { '--ggui-color-primary-600': '#7c3aed' }, dark: { '--ggui-color-primary-600': '#a78bfa' } },
    name: 'violet',
    cssVariables: { '--ggui-color-ground': '#fff' },
    frameless: true,
  };

  it('names the top-level members the incoming write would drop, in the stored order', () => {
    const incoming = { overlayHash: HASH, overlays: stored.overlays, name: 'violet' };
    expect(appThemeDroppedMembers(stored, incoming)).toEqual(['cssVariables', 'frameless']);
  });

  it('is EMPTY when the write carries everything the stored document holds — a changed VALUE is not a drop', () => {
    const carried = { ...stored, name: 'indigo', cssVariables: { '--ggui-color-ground': '#000' } };
    expect(appThemeDroppedMembers(stored, carried)).toEqual([]);
  });

  it('names a member this release does not know — the rule protects what it cannot validate', () => {
    // The point of the guard: a member written by a LATER release is exactly
    // what a strict schema cannot see and a whole-column write destroys.
    expect(appThemeDroppedMembers({ ...stored, sparkles: { on: true } }, stored)).toEqual(['sparkles']);
  });

  it('treats an explicit `undefined` in the incoming object as a drop — absent and undefined are the same wire fact', () => {
    expect(appThemeDroppedMembers(stored, { ...stored, frameless: undefined })).toEqual(['frameless']);
  });

  it('is empty against an absent or empty stored document — a first write drops nothing', () => {
    expect(appThemeDroppedMembers(undefined, stored)).toEqual([]);
    expect(appThemeDroppedMembers(null, stored)).toEqual([]);
    expect(appThemeDroppedMembers({}, stored)).toEqual([]);
  });

  it('refuses to guess about a non-object on either side — it reports nothing rather than inventing a drop', () => {
    expect(appThemeDroppedMembers('theme', stored)).toEqual([]);
    expect(appThemeDroppedMembers(stored, 'theme')).toEqual([]);
    expect(appThemeDroppedMembers(stored, [])).toEqual([]);
  });
});

describe('appThemeRefusalBodySchema — the wouldDrop arm (ggui#1124)', () => {
  it('accepts a refusal naming the members the write would have destroyed', () => {
    expect(appThemeRefusalBodySchema.safeParse({ wouldDrop: ['cssVariables', 'frameless'] }).success).toBe(true);
  });

  it('refuses an empty or malformed wouldDrop — a refusal that names nothing is not a teaching error', () => {
    expect(appThemeRefusalBodySchema.safeParse({ wouldDrop: [] }).success).toBe(false);
    expect(appThemeRefusalBodySchema.safeParse({ wouldDrop: 'cssVariables' }).success).toBe(false);
    expect(appThemeRefusalBodySchema.safeParse({ wouldDrop: ['a'], refused: 'v1 shape' }).success).toBe(false);
  });
});

// ggui#1124 — the founder's ruling: the refusal must name the COMPLIANCE
// PATH in itself, because "a refusal with no compliance path converts 'we
// protected your data' into 'we broke your write', and the writer cannot
// tell which happened". Naming the path turns a verdict into an instruction.
// ONE wording, exported, so every door carries it instead of paraphrasing.
describe('appThemeWouldDropRefusalText — the refusal is an instruction, not a verdict (ggui#1124)', () => {
  const text = appThemeWouldDropRefusalText(['cssVariables', 'frameless']);

  it('names the members that would have been dropped, so a writer can see whether they meant it', () => {
    expect(text).toContain('cssVariables');
    expect(text).toContain('frameless');
  });

  it('gives the carry path for a writer that did NOT mean to drop them', () => {
    expect(text).toMatch(/carry/i);
  });

  it('gives the clear-then-set path for a writer that DID mean to drop them — `theme: null`, true on EVERY door (ggui#1145)', () => {
    // ggui#1145 landed the uniform clear at the shared writer: `theme: null`
    // clears on PUT, PATCH, the ops tool and the replace-mode push alike, so
    // the refusal names the mechanism outright. The door-dependent hedge
    // (ggui#1124's `cb87cf0bc`) was a workaround for the asymmetry, not a
    // contract, and it leaves with the asymmetry.
    expect(text).toContain('send `theme: null`');
    expect(text).toMatch(/then/i);
    expect(text).toMatch(/NO theme between/);
  });

  it('no longer hedges the mechanism by door — the hedge was a workaround and the asymmetry is gone', () => {
    expect(text).not.toMatch(/depends on the door|door-dependent|differs by door|other doors differ/i);
  });

  it('says the app is themeless BETWEEN the two writes — nobody discovers that in production', () => {
    expect(text).toMatch(/themeless|no theme/i);
    expect(text).toMatch(/between/i);
  });

  it('refuses to render an empty list — a refusal that names nothing is not an instruction', () => {
    expect(() => appThemeWouldDropRefusalText([])).toThrow();
  });
});

// ggui#1155 — the CARRY read (REPRODUCE side). A theme GET exists so a writer can
// carry the stored document forward; it must return the document VERBATIM,
// unknown members included, or the #1124 guard refuses the carry-write that
// follows as `wouldDrop`. This is the door that must NOT strip.
describe('appThemeCarrySchema — the REPRODUCE-side theme read (ggui#1155)', () => {
  const stored = {
    overlayHash: 'a'.repeat(64),
    overlays: { light: { '--ggui-color-primary-600': '#7c3aed' }, dark: { '--ggui-color-primary-600': '#a78bfa' } },
    mode: 'dark',
    name: 'violet',
    futureMember: { any: 'shape' },
  };

  it('returns the stored document VERBATIM — a member this release does not name is kept, not stripped', () => {
    const r = appThemeCarrySchema.safeParse(stored);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual(stored);
    expect(Object.keys(r.data).sort()).toEqual(Object.keys(stored).sort());
  });

  it('still refuses what the write door refuses — a bad token is invalid, not carried', () => {
    const bad = { ...stored, overlays: { light: { 'not-a-ggui-var': '#000' }, dark: {} } };
    expect(appThemeCarrySchema.safeParse(bad).success).toBe(false);
  });
});

describe('appThemeGetResponseSchema — what the theme GET promises (ggui#1155)', () => {
  const theme = {
    overlayHash: 'b'.repeat(64),
    overlays: { light: {}, dark: {} },
    mode: 'light',
    futureMember: 1,
  };

  it('accepts `{ theme: null }` — an app with no theme', () => {
    expect(appThemeGetResponseSchema.safeParse({ theme: null }).success).toBe(true);
  });

  it('accepts a verbatim theme with `interpreted.stripped` naming what an INTERPRET reader would drop', () => {
    const r = appThemeGetResponseSchema.safeParse({ theme, interpreted: { stripped: ['futureMember'] } });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.theme).toEqual(theme);
    expect(r.data.interpreted).toEqual({ stripped: ['futureMember'] });
  });

  it('accepts a theme with NO `interpreted` — absence is the one way to say nothing was stripped', () => {
    expect(appThemeGetResponseSchema.safeParse({ theme }).success).toBe(true);
  });

  it('REFUSES `interpreted.stripped: []` — an empty list is not a second way to say absence', () => {
    expect(appThemeGetResponseSchema.safeParse({ theme, interpreted: { stripped: [] } }).success).toBe(false);
    expect(appThemeGetResponseSchema.safeParse({ theme, interpreted: {} }).success).toBe(false);
  });

  it('REFUSES an undeclared top-level member on the response — the door promises exactly this shape', () => {
    expect(appThemeGetResponseSchema.safeParse({ theme, extra: true }).success).toBe(false);
    expect(appThemeGetResponseSchema.safeParse({}).success).toBe(false);
  });
});
