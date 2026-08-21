/**
 * guuey-brand-v1 registration pins (ggui#589 ask 3 — the store-frame
 * gate). The theme's id is EXACTLY the `AppTheme.name` guuey's widget
 * already stamps on every render envelope, so the runtime's
 * name→registry binding selects it as the BASE ladder with no wire
 * change on the sender side. The slice overlay still wins above it
 * (#573 order unchanged).
 */
import { describe, expect, it } from 'vitest';
import { getScopedThemeCss } from '../rendering/css-tokens';
import { getTheme, getThemeIds } from './registry';

const RAMP_STOPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
const SEMANTIC_STOPS = ['50', '100', '200', '500', '600', '700', '800'];

function darkVars(): string {
  const theme = getTheme('guuey-brand-v1', 'dark');
  if (!theme) throw new Error('guuey-brand-v1 dark not registered');
  return theme.cssVariables;
}

// ── WCAG contrast sweep (ggui#589 round 7 / #594's pair class) ─────────
// Relative-luminance math per WCAG 2.x. rgba() values are composited
// over their ground first (the outline stops are alpha).

function channelLin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function parseColor(value: string): { r: number; g: number; b: number; a: number } {
  const hex = value.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgba) {
    return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  }
  throw new Error(`unparseable color: ${value}`);
}
function compositeOver(fg: string, bg: string): { r: number; g: number; b: number } {
  const f = parseColor(fg);
  const b = parseColor(bg);
  return {
    r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a),
  };
}
function luminance(c: { r: number; g: number; b: number }): number {
  return 0.2126 * channelLin(c.r) + 0.7152 * channelLin(c.g) + 0.0722 * channelLin(c.b);
}
function contrastRatio(fg: string, bg: string): number {
  const bgc = compositeOver(bg, '#000000');
  const fgc = compositeOver(fg, `rgb(${bgc.r}, ${bgc.g}, ${bgc.b})`.replace('rgb', 'rgba').replace(')', ', 1)'));
  const l1 = luminance(fgc);
  const l2 = luminance(bgc);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
function varsOf(mode: 'light' | 'dark'): Record<string, string> {
  const theme = getTheme('guuey-brand-v1', mode);
  if (!theme) throw new Error('guuey-brand-v1 not registered');
  const out: Record<string, string> = {};
  for (const line of theme.cssVariables.split('\n')) {
    const m = line.match(/^\s*(--ggui-[A-Za-z0-9-]+):\s*(.+);\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Every fg/bg pairing the registration can produce through the design
 * system's own consumption paths (tone slots, surface slots, Button/
 * Tabs/Checkbox variant styles, container roles). AA-at-normal-text
 * (≥ 4.5) is the bar — the founder-set gate for round 7.
 *
 * Deliberately EXCLUDED: `primary-500`-as-text (the 'loud' tone) —
 * sub-AA across every registered theme including stock; that is
 * #594's class-wide item, not this theme's defect.
 */
const AA_PAIRS: ReadonlyArray<readonly [string, string]> = [
  // Plain text on the three grounds.
  ['onSurface', 'surface'],
  ['onSurfaceVariant', 'surfaceVariant'],
  ['onSurfaceVariant', 'surface'],
  ['onContainer', 'container'],
  ['neutral-500', 'surface'], // hint text ('subtle' tone)
  // Solid-accent components (Button primary/danger, Tabs pills,
  // Checkbox mark) — bg is the -600 stop in the variant styles.
  ['onPrimary', 'primary-500'],
  ['onPrimary', 'primary-600'],
  ['onError', 'error-500'],
  ['onError', 'error-600'],
  // Container role pairs.
  ['onPrimaryContainer', 'primaryContainer'],
  ['onErrorContainer', 'errorContainer'],
  ['onTertiary', 'tertiary'],
  ['onTertiaryContainer', 'tertiaryContainer'],
  // Text tones on the plain surface (resolveToneCss consumers).
  ['primary-700', 'surface'], // 'emphasized'
  ['success-500', 'surface'],
  ['warning-500', 'surface'],
  ['error-500', 'surface'],
  ['info-500', 'surface'],
];

describe('guuey-brand-v1 — WCAG AA contrast sweep (round 7)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`${mode}: every producible fg/bg pair clears AA normal text (4.5)`, () => {
      const vars = varsOf(mode);
      const failures: string[] = [];
      for (const [fgKey, bgKey] of AA_PAIRS) {
        const fg = vars[`--ggui-color-${fgKey}`];
        const bg = vars[`--ggui-color-${bgKey}`];
        if (fg === undefined || bg === undefined) {
          failures.push(`${fgKey}/${bgKey}: token missing (fg=${fg}, bg=${bg})`);
          continue;
        }
        const ratio = contrastRatio(fg, bg);
        if (ratio < 4.5) {
          failures.push(`${fgKey} (${fg}) on ${bgKey} (${bg}) = ${ratio.toFixed(2)}`);
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }
});

describe('guuey-brand-v1 — registration', () => {
  it('is registered and resolves BOTH modes without fallback aliasing', () => {
    expect(getThemeIds()).toContain('guuey-brand-v1');
    const dark = getTheme('guuey-brand-v1', 'dark');
    const light = getTheme('guuey-brand-v1', 'light');
    expect(dark).toBeDefined();
    expect(light).toBeDefined();
    // Dark is the gating variant — it must be its own definition, not
    // the light-fallback the registry serves for single-mode themes.
    expect(dark?.cssVariables).not.toBe(light?.cssVariables);
  });

  it('dark pins the brand anchors: slime primary, slime SUCCESS (never green), portal surfaces', () => {
    const vars = darkVars();
    expect(vars).toContain('--ggui-color-primary-500: #B8FF3A');
    // The founder-rejected pixel: "Available" pills rendered our stock
    // green. guuey brand rule — success IS slime.
    expect(vars).toContain('--ggui-color-success-500: #B8FF3A');
    expect(vars).toContain('--ggui-color-surface: #1A1D24');
    expect(vars).toContain('--ggui-color-onSurface: #F6F5EE');
    expect(vars).toContain('--ggui-color-surfaceVariant: #242938');
    expect(vars).toContain('--ggui-color-onSurfaceVariant: #B7BAC4');
    expect(vars).toContain('--ggui-color-onPrimary: #0E1014');
    expect(vars).toContain('--ggui-color-onPrimaryContainer: #CCFF66');
  });

  it('dark fills the FULL consumer ramps — the -500/-600/-700 slots are the real consumers (census: 107 uses on -600)', () => {
    const vars = darkVars();
    for (const stop of RAMP_STOPS) {
      expect(vars, `primary-${stop} missing`).toContain(`--ggui-color-primary-${stop}:`);
      expect(vars, `neutral-${stop} missing`).toContain(`--ggui-color-neutral-${stop}:`);
    }
    for (const family of ['success', 'warning', 'error', 'info']) {
      for (const stop of SEMANTIC_STOPS) {
        expect(vars, `${family}-${stop} missing`).toContain(`--ggui-color-${family}-${stop}:`);
      }
    }
    // Hover stop carries the brand's lifted slime, not a derived grey.
    expect(vars).toContain('--ggui-color-primary-600: #CCFF66');
  });

  it('dark carries the brand chrome: DM Sans, slime focus ring, 12px card radius', () => {
    const vars = darkVars();
    expect(vars).toContain('DM Sans');
    expect(vars).toContain('--ggui-accessibility-focusRing-color: #B8FF3A');
    expect(vars).toContain('--ggui-shape-radius-lg: 0.75rem');
  });

  it('round 4 — dark borders sit at the portal hairline stops: outline .14, variant softer', () => {
    // The round-3 residual: outline at .18 blended to a slate-grey
    // hairline over the blue-slate surface (exec zoom crop). The
    // portal's map: .14 = the base hairline; .18 is the STRONG stop
    // (no DtcgTheme slot — strong strokes ride primary/focusRing,
    // which the Select button proved take brand).
    const vars = darkVars();
    expect(vars).toContain('--ggui-color-outline: rgba(246, 245, 238, 0.14)');
    expect(vars).toContain('--ggui-color-outlineVariant: rgba(246, 245, 238, 0.1)');
  });

  it('round 5 — frameless: the scoped CSS suppresses borders on the ROOT layer only (host rim owns the card silhouette)', () => {
    // Founder-ruled: the guuey host clips the WebView with its own
    // rounded rim; a square stroke on the document's outermost element
    // gets its corners amputated by the mask. The theme paints NO
    // border on the root layer — inner-container fog hairlines STAY.
    const scoped = getScopedThemeCss('guuey-brand-v1', 'gg-test', 'dark');
    expect(scoped).toContain('.gg-test > :where(:not(style)) { border: none !important; }');
    // Inner hairline stops are untouched — outline still resolves.
    expect(scoped).toContain('--ggui-color-outline: rgba(246, 245, 238, 0.14)');
    // Both modes carry the flag (the host rim exists in either scheme).
    expect(getScopedThemeCss('guuey-brand-v1', 'gg-test', 'light')).toContain(
      '.gg-test > :where(:not(style)) { border: none !important; }',
    );
    // Themes that do NOT declare frameless keep their root strokes —
    // console / claude.ai cards rely on them.
    expect(getScopedThemeCss('ggui', 'gg-test', 'dark')).not.toContain('border: none !important');
  });

  it('round 4 — dark shadows are near-none ink, never a heavy blob; light keeps soft grey', () => {
    const vars = darkVars();
    // The old mode-agnostic set (0.35–0.5 alpha black) painted a
    // visible dark blob under slot cards on the dark surface.
    expect(vars).not.toContain('rgba(0, 0, 0, 0.35)');
    expect(vars).not.toContain('rgba(0, 0, 0, 0.4)');
    expect(vars).toContain('--ggui-shape-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.2)');
    const light = getTheme('guuey-brand-v1', 'light');
    if (!light) throw new Error('light missing');
    expect(light.cssVariables).toContain(
      '--ggui-shape-shadow-sm: 0 1px 2px rgba(26, 29, 36, 0.06)',
    );
  });
});
