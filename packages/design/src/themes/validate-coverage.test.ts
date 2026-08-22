/**
 * Coverage-conformance validator (ggui#598 slice 2) — THE registration
 * gate for #598-C: a theme registration MUST cover the consumed-token
 * manifest or carry EXPLICIT group-inherit ($extensions, DTCG-
 * sanctioned). Silence is no longer a legal way to inherit — the
 * round-3 mechanism (sparse coverage silently defaulting) dies here.
 */
import { describe, expect, it } from 'vitest';
import manifest from './consumed-tokens.manifest.json' with { type: 'json' };
import { lightTheme as gguiLight } from './defaults/light.js';
import { darkTheme as gguiDark } from './defaults/dark.js';
import {
  NON_THEME_DEFINABLE_TOKENS,
  validateThemeCoverage,
} from './validate-coverage.js';


/**
 * Shape-valid-but-sparse registration document: the full DtcgTheme
 * section structure (registrations are shape-validated BEFORE coverage
 * runs) with almost no content — the round-3 shape, honestly modeled.
 */
function sparseDoc(extensions?: Record<string, unknown>) {
  // Sparse-in-the-Records: the DtcgTheme type mandates every semantic
  // SINGLE token, but ramp/scale Records are key-set-unenforced (the
  // #595 RCA's compiler blind spot) — which is exactly where real
  // sparse registrations are sparse. Ramps emptied, one primary stop
  // kept, scale Records emptied.
  return {
    ...gguiLight,
    ...(extensions !== undefined ? { $extensions: extensions } : {}),
    $name: 'Sparse',
    color: {
      ...gguiLight.color,
      primary: { '600': { $type: 'color', $value: '#123456' } },
      neutral: {},
      success: {},
      warning: {},
      error: {},
      info: {},
    },
    font: { ...gguiLight.font, size: {}, weight: {}, lineHeight: {} },
    spacing: {},
  } as typeof gguiLight;
}

describe('validateThemeCoverage — the registration gate', () => {
  it('the DEFAULT theme pair covers the manifest 100% (no inherit, no gaps) — it IS the terminal fallback', () => {
    const result = validateThemeCoverage(
      { light: gguiLight, dark: gguiDark },
      manifest.tokens,
    );
    expect(result.covered).toBe(true);
    expect(result.uncovered.light).toEqual([]);
    expect(result.uncovered.dark).toEqual([]);
    expect(result.inheritMatched).toEqual([]);
  });

  it('a sparse registration FAILS, naming every uncovered token per mode', () => {
    // The round-3 shape: a 1-token "brand" atop nothing.
    const sparse = sparseDoc();
    const result = validateThemeCoverage(
      { light: sparse, dark: sparse },
      manifest.tokens,
    );
    expect(result.covered).toBe(false);
    expect(result.uncovered.light.length).toBeGreaterThan(40);
    expect(result.uncovered.light).toContain('--ggui-spacing-md');
    expect(result.uncovered.dark).toContain('--ggui-color-success-500');
  });

  it('explicit group-inherit covers by declaration — and is REPORTED, never silent', () => {
    const sparseWithInherit = sparseDoc({
      'ai.ggui.coverage': { inherit: ['--ggui-*'] },
    });
    const result = validateThemeCoverage(
      { light: sparseWithInherit, dark: sparseWithInherit },
      manifest.tokens,
    );
    expect(result.covered).toBe(true);
    expect(result.uncovered.light).toEqual([]);
    // The inherit is on the record — the grade shows WHAT was inherited.
    expect(result.inheritMatched.length).toBeGreaterThan(40);
  });

  it('inherit patterns are prefix-globs over emitted names — a non-matching pattern covers nothing', () => {
    const sparse = sparseDoc({
      'ai.ggui.coverage': { inherit: ['--ggui-spacing-*'] },
    });
    const result = validateThemeCoverage(
      { light: sparse, dark: sparse },
      manifest.tokens,
    );
    expect(result.covered).toBe(false);
    expect(result.uncovered.light).not.toContain('--ggui-spacing-md');
    expect(result.uncovered.light).toContain('--ggui-color-success-500');
  });

  it('the non-definable exclusion list is pinned: every entry is IN the manifest and none is parser-emittable by the default pair', () => {
    // These are consumed tokens NO registration can define (derived
    // formulas, wrong-prefix names, element-level opt-ins) — excluded
    // from the coverage obligation WITH receipts in the source.
    for (const token of NON_THEME_DEFINABLE_TOKENS) {
      expect(manifest.tokens).toContain(token);
    }
    const result = validateThemeCoverage(
      { light: gguiLight, dark: gguiDark },
      manifest.tokens,
    );
    // If the default pair ever starts emitting one, the exclusion is
    // stale and must shrink — this pin surfaces it.
    for (const token of NON_THEME_DEFINABLE_TOKENS) {
      expect(result.excluded).toContain(token);
    }
  });
});
