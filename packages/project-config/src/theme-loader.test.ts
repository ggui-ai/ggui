/**
 * Tests for theme loading. Exercises the walk-and-parse flow against
 * real filesystem fixtures (tempdirs, not mocked `fs`). Mirrors the
 * primitive-discovery and blueprint-discovery test styles.
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GguiJsonV1 } from './schema.js';
import { loadTheme, loadThemeFromGguiJsonPath } from './theme-loader.js';
import type { ThemeDocument } from './theme.js';

function minimalTheme(): ThemeDocument {
  return {
    color: {
      primary: { '500': { $type: 'color', $value: '#0ea5e9' } },
      success: { '500': { $type: 'color', $value: '#16a34a' } },
      warning: { '500': { $type: 'color', $value: '#f59e0b' } },
      error: { '500': { $type: 'color', $value: '#dc2626' } },
      info: { '500': { $type: 'color', $value: '#2563eb' } },
      ground: { $type: 'color', $value: '#ffffff' },
      onGround: { $type: 'color', $value: '#111827' },
      container: { $type: 'color', $value: '#ffffff' },
      onContainer: { $type: 'color', $value: '#111827' },
      sunken: { $type: 'color', $value: '#f3f4f6' },
      onSunken: { $type: 'color', $value: '#374151' },
    },
    spacing: {
      '4': { $type: 'dimension', $value: '16px' },
    },
    font: {
      family: {
        sans: { $type: 'fontFamily', $value: ['Inter', 'system-ui'] },
      },
      weight: {
        regular: { $type: 'fontWeight', $value: 400 },
      },
    },
    shape: {
      radius: { md: { $type: 'dimension', $value: '8px' } },
      shadow: {
        sm: {
          $type: 'shadow',
          $value: {
            offsetX: '0',
            offsetY: '1px',
            blur: '2px',
            spread: '0',
            color: 'rgba(0,0,0,.05)',
          },
        },
      },
    },
  };
}

function makeGgui(overrides: Partial<GguiJsonV1> = {}): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { slug: 'test', name: 'Test' },
    blueprints: { include: [] },
    primitives: { packages: ['@ggui-ai/design/primitives'], local: [] },
    mcpMounts: [],
    ...overrides,
  };
}

describe('loadTheme — default path', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-theme-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('falls back to the shipped default when `theme` is absent', () => {
    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.source).toBe('default');
    expect(result.theme.document.color).toBeDefined();
    expect(result.theme.document.spacing).toBeDefined();
    expect(result.theme.overlays.light['--ggui-color-primary-500']).toMatch(/^#[0-9a-f]{6}$/i);
    expect(result.theme.overlays.dark['--ggui-color-ground']).toBeDefined();
  });

  it('throws when projectRoot is not absolute', () => {
    expect(() =>
      loadTheme({ projectRoot: 'relative', manifest: makeGgui() }),
    ).toThrow(/absolute/);
  });
});

describe('loadTheme — file path', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-theme-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loads and parses a valid theme file at a relative path', () => {
    const themePath = join(tmp, 'theme.json');
    writeFileSync(themePath, JSON.stringify(minimalTheme()));

    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: { file: './theme.json' } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.source).toBe('file');
    if (result.theme.source === 'file') {
      expect(result.theme.path).toBe(themePath);
    }
    expect(result.theme.overlays.light['--ggui-color-primary-500']).toBe('#0ea5e9');
    expect(result.theme.overlays.dark['--ggui-color-primary-500']).toBe('#0ea5e9');
  });

  it('accepts an absolute path as-is', () => {
    const nested = join(tmp, 'themes');
    mkdirSync(nested);
    const themePath = join(nested, 'brand.json');
    writeFileSync(themePath, JSON.stringify(minimalTheme()));

    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: { file: themePath } }),
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.theme.source === 'file') {
      expect(result.theme.path).toBe(themePath);
    }
  });

  it('surfaces an issue when the declared theme file is missing', () => {
    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: { file: './missing.json' } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.path).toBe('./missing.json');
    expect(result.issue.message).toMatch(/not found/i);
  });

  it('surfaces an issue when the file is not valid JSON', () => {
    const themePath = join(tmp, 'theme.json');
    writeFileSync(themePath, '{ not valid json');

    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: { file: './theme.json' } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.path).toBe(themePath);
    expect(result.issue.message).toMatch(/not valid JSON/);
  });

  it('surfaces an issue when the file fails schema validation', () => {
    const themePath = join(tmp, 'theme.json');
    writeFileSync(
      themePath,
      JSON.stringify({ color: {}, spacing: {} }), // missing font/shape
    );

    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: { file: './theme.json' } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.path).toBe(themePath);
    expect(result.issue.message).toMatch(/schema validation/);
  });

  it("surfaces an issue with the declared path (not the resolved path) for unreadable paths", () => {
    // Relative path the operator declared should show up in the
    // issue so they can match it against their ggui.json.
    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: { file: './themes/missing.json' } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.path).toBe('./themes/missing.json');
  });
});

describe('loadThemeFromGguiJsonPath', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-theme-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves projectRoot from the given manifest path', () => {
    const themePath = join(tmp, 'theme.json');
    writeFileSync(themePath, JSON.stringify(minimalTheme()));
    const gguiPath = join(tmp, 'ggui.json');

    const result = loadThemeFromGguiJsonPath(
      gguiPath,
      makeGgui({ theme: { file: './theme.json' } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.theme.source === 'file') {
      expect(result.theme.path).toBe(themePath);
    }
  });
});

describe('loadTheme — preset path', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-theme-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loads a registered preset via the string shorthand', () => {
    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: 'claudic' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.source).toBe('preset');
    if (result.theme.source !== 'preset') return;
    expect(result.theme.preset).toBe('claudic');
    expect(result.theme.mode).toBe('light');
    expect(result.theme.overlays.light['--ggui-color-primary-500']).toBeDefined();
    expect(result.theme.overlays.dark['--ggui-color-primary-500']).toBeDefined();
  });

  it('loads a registered preset via the object form with explicit mode', () => {
    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: { preset: 'claudic', mode: 'dark' } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.source).toBe('preset');
    if (result.theme.source !== 'preset') return;
    expect(result.theme.preset).toBe('claudic');
    expect(result.theme.mode).toBe('dark');
  });

  it('carries BOTH overlays whichever mode is declared; mode selects the document; the two overlays differ', () => {
    const light = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: { preset: 'claudic', mode: 'light' } }),
    });
    const dark = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: { preset: 'claudic', mode: 'dark' } }),
    });
    expect(light.ok && dark.ok).toBe(true);
    if (!light.ok || !dark.ok) return;
    expect(light.theme.mode).toBe('light');
    expect(dark.theme.mode).toBe('dark');
    expect(light.theme.overlays.light).toEqual(dark.theme.overlays.light);
    expect(light.theme.overlays.light).not.toEqual(light.theme.overlays.dark);
  });

  it('applies flat dot-path overrides onto the preset before CSS emission', () => {
    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({
        theme: {
          preset: 'claudic',
          overrides: { 'color.primary.500': '#ff00ff' },
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.source).toBe('preset');
    if (result.theme.source !== 'preset') return;
    expect(result.theme.overrides).toEqual({
      'color.primary.500': '#ff00ff',
    });
    // The override is on the leaf value, so the emitted CSS contains
    // the new color string for the corresponding variable.
    expect(result.theme.overlays.light['--ggui-color-primary-500']).toBe('#ff00ff');
  });

  it('silently ignores override paths that do not resolve to a token leaf', () => {
    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({
        theme: {
          preset: 'claudic',
          overrides: {
            'color.primary.500': '#ff00ff', // valid
            'color.primary.does-not-exist': '#000000', // invalid leaf
            'totally.bogus.path': '#000000', // invalid root
          },
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.theme.source !== 'preset') return;
    expect(result.theme.overlays.light['--ggui-color-primary-500']).toBe('#ff00ff');
    // Bogus paths leave no trace in the projection.
    expect('--ggui-color-primary-does-not-exist' in result.theme.overlays.light).toBe(false);
  });

  it('does not pollute the registry cache when overrides are applied', () => {
    // Apply an override, then load the same preset without overrides.
    // The second load should see the original preset value, not the
    // override.
    const overridden = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({
        theme: {
          preset: 'claudic',
          overrides: { 'color.primary.500': '#ff00ff' },
        },
      }),
    });
    const clean = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: 'claudic' }),
    });
    expect(overridden.ok && clean.ok).toBe(true);
    if (!overridden.ok || !clean.ok) return;
    expect(clean.theme.overlays.light['--ggui-color-primary-500']).not.toBe('#ff00ff');
    expect(clean.theme.overlays.light['--ggui-color-primary-500']).toBe('#cc785c'); // Crail
  });

  it('surfaces an issue when the preset is not registered', () => {
    const result = loadTheme({
      projectRoot: tmp,
      manifest: makeGgui({ theme: { preset: 'does-not-exist' } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.path).toBe('does-not-exist');
    expect(result.issue.message).toMatch(/not registered/i);
  });
});
