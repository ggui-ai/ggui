/**
 * Pure-helper tests for the `/theme` picker. The React component
 * itself is exercised manually + by E2E (the auth gate isn't worth
 * mocking out for vitest); the assertions here cover the three
 * functions that decide what gets POSTed to `/ggui/console/theme`:
 *
 *   - `readSelection`  — `ThemeConfig | null` → `(presetId, mode, overrides, fromFile)`
 *   - `buildPostBody`  — `(presetId, mode, overrides)` → minimal `ThemeConfig`
 *   - `flattenLeaves`  — `DtcgTheme` → ordered editor groups + leaves
 */
import { getRawTheme } from '@ggui-ai/design/themes';
import { describe, expect, it } from 'vitest';
import { buildPostBody, flattenLeaves, readSelection } from './Theme.js';

describe('readSelection', () => {
  const DEFAULT = 'ggui';

  it('returns the default preset on null', () => {
    expect(readSelection(null, DEFAULT)).toEqual({
      presetId: 'ggui',
      mode: 'light',
      fromFile: false,
      overrides: {},
    });
  });

  it('expands a string shorthand to (preset, light, no overrides)', () => {
    expect(readSelection('claudic', DEFAULT)).toEqual({
      presetId: 'claudic',
      mode: 'light',
      fromFile: false,
      overrides: {},
    });
  });

  it('reads preset object form with mode + overrides', () => {
    expect(
      readSelection(
        {
          preset: 'claudic',
          mode: 'dark',
          overrides: { 'color.primary.500': '#d97757' },
        },
        DEFAULT,
      ),
    ).toEqual({
      presetId: 'claudic',
      mode: 'dark',
      fromFile: false,
      overrides: { 'color.primary.500': '#d97757' },
    });
  });

  it('flags file form so the UI can warn before overwriting', () => {
    const sel = readSelection({ file: './theme.json', mode: 'dark' }, DEFAULT);
    expect(sel).toEqual({
      presetId: 'ggui',
      mode: 'dark',
      fromFile: true,
      overrides: {},
    });
  });

  it('defaults file-form mode to light when omitted', () => {
    const sel = readSelection({ file: './theme.json' }, DEFAULT);
    expect(sel.mode).toBe('light');
  });
});

describe('buildPostBody', () => {
  it('emits the bare object form when overrides is empty', () => {
    expect(buildPostBody('claudic', 'light', {})).toEqual({
      preset: 'claudic',
      mode: 'light',
    });
  });

  it('includes overrides when non-empty', () => {
    expect(
      buildPostBody('claudic', 'dark', {
        'color.primary.500': '#d97757',
      }),
    ).toEqual({
      preset: 'claudic',
      mode: 'dark',
      overrides: { 'color.primary.500': '#d97757' },
    });
  });

  it('sorts override keys for byte-stable round-trips', () => {
    // Operator types `color.primary.700` then `color.primary.500` — the
    // serialised body must stay key-stable so a no-op save doesn't
    // produce a spurious `git diff` (the writer JSON.stringify rewrites
    // the manifest on every save).
    const body = buildPostBody('claudic', 'light', {
      'shape.radius.lg': '8px',
      'color.primary.500': '#d97757',
      'color.primary.700': '#a35640',
    });
    expect(body).toEqual({
      preset: 'claudic',
      mode: 'light',
      overrides: {
        'color.primary.500': '#d97757',
        'color.primary.700': '#a35640',
        'shape.radius.lg': '8px',
      },
    });
    // Stringify-stable assertion to lock the key order — Object.entries
    // preserves insertion order in V8/JSC, so this is meaningful.
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        preset: 'claudic',
        mode: 'light',
        overrides: {
          'color.primary.500': '#d97757',
          'color.primary.700': '#a35640',
          'shape.radius.lg': '8px',
        },
      }),
    );
  });
});

describe('flattenLeaves', () => {
  // Use the real `claudic` theme from the registry — exercises the
  // full DtcgTheme shape including ladders, semantic roles, motion
  // (skipped from output), and shadow.
  const theme = getRawTheme('claudic', 'light');
  if (!theme) throw new Error('claudic preset must be registered');

  it('emits the canonical group order', () => {
    const groups = flattenLeaves(theme);
    expect(groups.map((g) => g.prefix)).toEqual([
      'color.primary',
      'color.neutral',
      'color',
      'shape.radius',
      'shape.shadow',
      'font.family',
      'font.size',
      'font.weight',
      'spacing',
    ]);
  });

  it('sorts numeric ladder stops numerically (not lexicographically)', () => {
    const groups = flattenLeaves(theme);
    const primary = groups.find((g) => g.prefix === 'color.primary');
    expect(primary).toBeDefined();
    const stops = primary!.leaves.map((l) => {
      const segs = l.path.split('.');
      return segs[segs.length - 1]!;
    });
    // Stops should be in numeric order — `100` BEFORE `1000`, not after.
    const numeric = stops.filter((s) => /^\d+$/.test(s)).map(Number);
    const sorted = [...numeric].sort((a, b) => a - b);
    expect(numeric).toEqual(sorted);
  });

  it('serialises every leaf $value as a string', () => {
    const groups = flattenLeaves(theme);
    for (const group of groups) {
      for (const leaf of group.leaves) {
        expect(typeof leaf.value).toBe('string');
        expect(leaf.value.length).toBeGreaterThan(0);
      }
    }
  });

  it('emits 12 semantic-color leaves under prefix `color`', () => {
    const groups = flattenLeaves(theme);
    const semantic = groups.find((g) => g.prefix === 'color' && g.label.includes('Semantic'));
    expect(semantic).toBeDefined();
    expect(semantic!.leaves).toHaveLength(12);
    const paths = semantic!.leaves.map((l) => l.path);
    // Probe the high-signal ones.
    expect(paths).toContain('color.surface');
    expect(paths).toContain('color.onSurface');
    expect(paths).toContain('color.error');
    expect(paths).toContain('color.outline');
  });

  it('includes mono font family when the preset ships one', () => {
    const groups = flattenLeaves(theme);
    const family = groups.find((g) => g.prefix === 'font.family');
    expect(family).toBeDefined();
    const paths = family!.leaves.map((l) => l.path);
    expect(paths).toContain('font.family.sans');
    // Claudic ships both — keeps the assertion meaningful.
    expect(paths).toContain('font.family.mono');
  });

  it('drops empty groups', () => {
    // Build a degenerate theme with empty ladders and verify that the
    // editor doesn't emit a header for them. Manually clone + clear
    // the ladders we care about.
    const degen = {
      ...theme,
      color: {
        ...theme.color,
        primary: {},
        neutral: {},
      },
      shape: {
        ...theme.shape,
        radius: {},
        shadow: {},
      },
      font: {
        ...theme.font,
        size: {},
        weight: {},
      },
      spacing: {},
    };
    const groups = flattenLeaves(degen);
    const prefixes = groups.map((g) => g.prefix);
    expect(prefixes).not.toContain('color.primary');
    expect(prefixes).not.toContain('color.neutral');
    expect(prefixes).not.toContain('shape.radius');
    expect(prefixes).not.toContain('shape.shadow');
    expect(prefixes).not.toContain('font.size');
    expect(prefixes).not.toContain('font.weight');
    expect(prefixes).not.toContain('spacing');
    // Semantic colors + font.family.sans always survive.
    expect(prefixes).toContain('color');
    expect(prefixes).toContain('font.family');
  });
});
