/**
 * `deriveThemeVariables(doc, mode)` — the ONE producer of a theme's
 * projected variable set (ggui#987 §2.4).
 *
 * A theme is one DTCG document; its projection is the map of `--ggui-*`
 * variables a card will read — exactly the consumed-token manifest
 * (`consumed-tokens.manifest.json`) minus the exclusion floor, nothing
 * more, nothing less. Every path that paints a theme produces that map
 * through this function: compiled registry themes, `ggui.json#theme`
 * documents, the console's presets, and an embedding host composing a
 * per-app overlay from its own theme — so byte-equality between
 * producers holds by construction, never by re-implementation.
 *
 * What the document states is emitted as stated; what it leaves
 * unstated is DERIVED by the rules of the §2.4 table:
 *
 *   - `elevated` is never authored: light = `container`; dark =
 *     `container` mixed 8% toward `onContainer`; `onElevated` = `onContainer`.
 *   - the neutral ramp interpolates `ground → onGround` at fixed stops;
 *     `outline` / `outlineVariant` are its 300 / 200 stops.
 *   - each accent / tone family is synthesised from its `500` anchor:
 *     the anchor's hue, fixed lightness targets, chroma scaled per stop;
 *     `tertiary` defaults to `primary`.
 *   - `onX` is the one of `#ffffff` / `#000000` with the higher WCAG
 *     contrast against `X-500`; `XContainer` / `onXContainer` are the
 *     family's 100 / 900 stops (light) or 800 / 100 (dark).
 *   - flat `error` = `error-500`; `link` = the stated link, else
 *     `primary-600` — stated wins, an alias is never appended over it.
 *   - font sizes come from `font.ramp { base, ratio }` by the exponent
 *     table (xs −2 … 4xl +5), else the layer-1 ladder; weights, line
 *     heights, letter-spacing defaults, shadows, radii and spacing fall
 *     back to the layer-1 constants in `../tokens`.
 *
 * Colour space: every derived colour is computed in OKLCH, gamut-clamped
 * to sRGB by reducing chroma, rounded to 4 decimals before conversion,
 * and emitted as 6-digit lowercase hex. Stated colours pass through
 * untouched (lower-cased when hex).
 *
 * A manifest name this function has no rule for is a defect the
 * manifest test names, not a silent gap: the function throws.
 */
import type { DtcgTheme, DtcgToken, ThemeMode } from './types';
import { consumedTokenManifest } from './consumed-tokens';
import { NON_THEME_DEFINABLE_TOKENS } from './validate-overlay-coverage';
import { fontFamily, fontSize, fontWeight, lineHeight } from '../tokens/typography';
import { spacing as spacingLadder, radius as radiusLadder, shadow as shadowLadder } from '../tokens/spacing';

/** The projected variable set: `--ggui-*` name → CSS value. */
export type ThemeVariableMap = Readonly<Record<string, string>>;

/** OKLCH triple: lightness 0..1, chroma ≥ 0, hue in degrees [0, 360). */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/** Thrown when a document lacks something the derivation cannot supply. */
export class ThemeDocumentInvalidError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`theme document invalid: missing ${missing.join(', ')}`);
    this.name = 'ThemeDocumentInvalidError';
    this.missing = missing;
  }
}

// ───── OKLCH core (Björn Ottosson's OKLab; sRGB D65) ─────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb8(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(clamp01(c) * 255);
}

function parseHex(hex: string): readonly [number, number, number] {
  const h = hex.trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new ThemeDocumentInvalidError([`colour ${JSON.stringify(hex)} is not 6-digit hex`]);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function linearToOklab(r: number, g: number, b: number): readonly [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear(L: number, a: number, b: number): readonly [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Parse a 3- or 6-digit hex colour into OKLCH. */
export function hexToOklch(hex: string): Oklch {
  const [r8, g8, b8] = parseHex(hex);
  const [L, a, b] = linearToOklab(srgbToLinear(r8), srgbToLinear(g8), srgbToLinear(b8));
  const c = Math.hypot(a, b);
  const h = c < 1e-6 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

function inGamut(rgb: readonly [number, number, number]): boolean {
  const eps = 1e-6;
  return rgb.every((v) => v >= -eps && v <= 1 + eps);
}

/**
 * OKLCH → 6-digit lowercase hex. Out-of-gamut colours are brought into
 * sRGB by reducing chroma (binary search) — hue and lightness are kept.
 */
export function oklchToHex(color: Oklch): string {
  const l = clamp01(round4(color.l));
  const h = round4(((color.h % 360) + 360) % 360);
  let c = Math.max(0, round4(color.c));
  const toLinear = (chroma: number) => {
    const rad = (h * Math.PI) / 180;
    return oklabToLinear(l, chroma * Math.cos(rad), chroma * Math.sin(rad));
  };
  let rgb = toLinear(c);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(toLinear(mid))) lo = mid;
      else hi = mid;
    }
    c = lo;
    rgb = toLinear(c);
  }
  const [r, g, b] = rgb.map(clamp01) as [number, number, number];
  return `#${[r, g, b].map((v) => linearToSrgb8(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Mix `a → b` at `t` in OKLCH (hue along the shorter arc). */
export function mixOklch(a: string, b: string, t: number): string {
  const A = hexToOklch(a);
  const B = hexToOklch(b);
  let dh = B.h - A.h;
  if (A.c < 1e-4) dh = 0;
  else if (B.c < 1e-4) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const h = A.c < 1e-4 ? B.h : A.h + dh * t;
  return oklchToHex({ l: A.l + (B.l - A.l) * t, c: A.c + (B.c - A.c) * t, h });
}

function relativeLuminance(hex: string): number {
  const [r8, g8, b8] = parseHex(hex);
  return 0.2126 * srgbToLinear(r8) + 0.7152 * srgbToLinear(g8) + 0.0722 * srgbToLinear(b8);
}

/** WCAG 2.x contrast ratio between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ───── the derivation ─────

const STOPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;
const RAMP_L = [0.97, 0.93, 0.86, 0.76, 0.66, NaN, 0.5, 0.42, 0.34, 0.26] as const;
const RAMP_C = [0.15, 0.3, 0.5, 0.75, 0.9, 1, 0.95, 0.85, 0.7, 0.55] as const;
const NEUTRAL_T = [0.04, 0.08, 0.16, 0.28, 0.44, 0.58, 0.7, 0.8, 0.9, 0.96] as const;
const FAMILIES = ['primary', 'tertiary', 'success', 'warning', 'error', 'info'] as const;
/** The named spacing steps primitives read beside the numeric ladder — layer-1 defaults. */
const NAMED_SPACING: Readonly<Record<string, string>> = { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px', '2xl': '48px' };
const SIZE_EXP: Readonly<Record<string, number>> = { xs: -2, sm: -1, base: 0, lg: 1, xl: 2, '2xl': 3, '3xl': 4, '4xl': 5 };

type Tokens = Readonly<Record<string, DtcgToken<unknown> | undefined>> | undefined;

function tokenValue(t: DtcgToken<unknown> | undefined): string | undefined {
  if (t === undefined || t === null || typeof t !== 'object' || !('$value' in t)) return undefined;
  const v = (t as DtcgToken<unknown>).$value;
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return undefined;
  return /^#[0-9a-fA-F]{3,6}$/.test(v) ? `#${parseHex(v).map((n) => n.toString(16).padStart(2, '0')).join('')}` : v;
}

function stated(group: Tokens, key: string): string | undefined {
  return tokenValue(group?.[key]);
}

/** Synthesise a family's ten stops from its `500` anchor (stated stops win). */
function familyRamp(group: Tokens, anchor: string): Record<string, string> {
  const a = hexToOklch(anchor);
  const out: Record<string, string> = {};
  STOPS.forEach((stop, i) => {
    const s = stated(group, stop);
    if (s !== undefined) {
      out[stop] = s;
      return;
    }
    out[stop] = stop === '500' ? anchor : oklchToHex({ l: RAMP_L[i]!, c: a.c * RAMP_C[i]!, h: a.h });
  });
  return out;
}

function onColourFor(base: string): string {
  return contrastRatio('#ffffff', base) >= contrastRatio('#000000', base) ? '#ffffff' : '#000000';
}

function parseSize(value: string): { n: number; unit: string } | undefined {
  const m = /^([0-9.]+)\s*(rem|px|em)$/.exec(value.trim());
  return m ? { n: Number(m[1]), unit: m[2]! } : undefined;
}

/**
 * The one producer. See the module header for the rules.
 */
export function deriveThemeVariables(doc: DtcgTheme, mode: ThemeMode): ThemeVariableMap {
  const c = doc.color as unknown as Readonly<Record<string, Tokens | DtcgToken<unknown> | undefined>>;
  const single = (key: string): string | undefined => tokenValue(c[key] as DtcgToken<unknown> | undefined);
  const group = (key: string): Tokens => c[key] as Tokens;
  const V: Record<string, string> = {};
  const missing: string[] = [];
  const need = (key: string): string => {
    const v = single(key);
    if (v === undefined) missing.push(`color.${key}`);
    return v ?? '#000000';
  };

  // Roles — required.
  const ground = need('ground');
  const onGround = need('onGround');
  const container = need('container');
  const onContainer = need('onContainer');
  const sunken = need('sunken');
  const onSunken = need('onSunken');
  Object.assign(V, {
    '--ggui-color-ground': ground,
    '--ggui-color-onGround': onGround,
    '--ggui-color-container': container,
    '--ggui-color-onContainer': onContainer,
    '--ggui-color-sunken': sunken,
    '--ggui-color-onSunken': onSunken,
    '--ggui-color-elevated': mode === 'light' ? container : mixOklch(container, onContainer, 0.08),
    '--ggui-color-onElevated': onContainer,
  });

  // Neutral ramp: stated stops, else ground → onGround interpolation.
  const neutral = group('neutral');
  STOPS.forEach((stop, i) => {
    V[`--ggui-color-neutral-${stop}`] = stated(neutral, stop) ?? mixOklch(ground, onGround, NEUTRAL_T[i]!);
  });
  V['--ggui-color-outline'] = single('outline') ?? V['--ggui-color-neutral-300']!;
  V['--ggui-color-outlineVariant'] = single('outlineVariant') ?? V['--ggui-color-neutral-200']!;

  // Accent + tone families from their 500 anchors.
  const primaryAnchor = stated(group('primary'), '500');
  if (primaryAnchor === undefined) missing.push('color.primary.500');
  for (const fam of FAMILIES) {
    const g = group(fam);
    let anchor = fam === 'tertiary' ? single('tertiary') : stated(g, '500');
    if (anchor === undefined) {
      if (fam === 'tertiary') anchor = primaryAnchor ?? '#000000';
      else {
        missing.push(`color.${fam}.500`);
        anchor = '#000000';
      }
    }
    const ramp = familyRamp(g, anchor);
    for (const stop of STOPS) V[`--ggui-color-${fam}-${stop}`] = ramp[stop]!;
    const cap = fam[0]!.toUpperCase() + fam.slice(1);
    V[`--ggui-color-on${cap}`] = single(`on${cap}`) ?? onColourFor(ramp['500']!);
    V[`--ggui-color-${fam}Container`] = single(`${fam}Container`) ?? (mode === 'light' ? ramp['100']! : ramp['800']!);
    V[`--ggui-color-on${cap}Container`] = single(`on${cap}Container`) ?? (mode === 'light' ? ramp['900']! : ramp['100']!);
  }
  V['--ggui-color-error'] = V['--ggui-color-error-500']!;
  V['--ggui-color-link'] = single('link') ?? V['--ggui-color-primary-600']!;

  // Typography.
  const family = doc.font.family;
  const sans = tokenValue(family.sans) ?? fontFamily.sans;
  V['--ggui-font-family-sans'] = sans;
  V['--ggui-font-family-mono'] = tokenValue(family.mono) ?? fontFamily.mono;
  V['--ggui-font-family-heading'] = tokenValue(family.heading) ?? sans;
  const weights = doc.font.weight as Tokens;
  for (const w of ['normal', 'medium', 'semibold', 'bold'] as const) V[`--ggui-font-weight-${w}`] = stated(weights, w) ?? String(fontWeight[w]);
  V['--ggui-font-weight-heading'] = stated(weights, 'heading') ?? String(fontWeight.bold);
  const spacingT = doc.font.letterSpacing as Tokens;
  V['--ggui-letter-spacing-body'] = stated(spacingT, 'body') ?? '0em';
  V['--ggui-letter-spacing-heading'] = stated(spacingT, 'heading') ?? '-0.01em';
  for (const lh of Object.keys(lineHeight) as Array<keyof typeof lineHeight>) V[`--ggui-font-lineHeight-${lh}`] = String(lineHeight[lh]);
  const ramp = doc.font.ramp;
  const base = ramp ? parseSize(tokenValue(ramp.base) ?? '') : undefined;
  const ratio = ramp ? Number(tokenValue(ramp.ratio)) : NaN;
  for (const [stop, exp] of Object.entries(SIZE_EXP)) {
    V[`--ggui-font-size-${stop}`] =
      base && Number.isFinite(ratio) && ratio > 0
        ? `${Math.round(base.n * ratio ** exp * 1000) / 1000}${base.unit}`
        : fontSize[stop as keyof typeof fontSize];
  }

  // Spacing, shape — stated, else the layer-1 ladders.
  const sp = doc.spacing as Tokens;
  for (const [key, value] of Object.entries(spacingLadder)) V[`--ggui-spacing-${key}`] = stated(sp, key) ?? String(value);
  for (const [key, value] of Object.entries(NAMED_SPACING)) V[`--ggui-spacing-${key}`] = stated(sp, key) ?? value;
  const rad = doc.shape?.radius as Tokens;
  for (const [key, value] of Object.entries(radiusLadder)) V[`--ggui-shape-radius-${key}`] = stated(rad, key) ?? String(value);
  const sh = doc.shape?.shadow as Tokens;
  for (const [key, value] of Object.entries(shadowLadder)) V[`--ggui-shape-shadow-${key}`] = stated(sh, key) ?? String(value);

  if (missing.length > 0) throw new ThemeDocumentInvalidError(missing);

  // Project onto the manifest — exactly, minus the floor.
  const floor = new Set(NON_THEME_DEFINABLE_TOKENS);
  const out: Record<string, string> = {};
  const gaps: string[] = [];
  for (const name of consumedTokenManifest) {
    if (floor.has(name)) continue;
    const v = V[name];
    if (v === undefined) gaps.push(name);
    else out[name] = v;
  }
  if (gaps.length > 0) throw new Error(`deriveThemeVariables: no rule for manifest token(s) ${gaps.join(', ')} — extend the §2.4 table`);
  return out;
}
