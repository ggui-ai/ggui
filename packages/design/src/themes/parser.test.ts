import { describe, expect, it } from 'vitest';
import { lightTheme } from './defaults/light';
import { darkTheme } from './defaults/dark';
import {
  generateCssVariables,
  generateThemeReferenceDocumentation,
  parseTheme,
  themeToCssVarReferences,
} from './parser';
import { deriveThemeVariables } from './derive-theme-variables';
import { validateOverlayCoverage } from './validate-overlay-coverage';
import { getRawTheme, getThemeIds } from './registry';

// ggui#987 §2.4 — the projection IS the manifest: every emitted variable is
// one a card reads, and every variable a card reads is emitted by every theme.

describe('generateCssVariables', () => {
  it('emits the surface-layering role pairs and the primary ramp (§2.1)', () => {
    const css = generateCssVariables(lightTheme, 'light');
    for (const role of ['ground', 'onGround', 'container', 'onContainer', 'sunken', 'onSunken', 'elevated', 'onElevated']) {
      expect(css).toMatch(new RegExp(`--ggui-color-${role}: #[0-9a-f]{6};`));
    }
    expect(css).toMatch(/--ggui-color-primary-600: #[0-9a-f]{6};/);
  });

  it('emits the spacing ladder and the named steps', () => {
    const css = generateCssVariables(lightTheme, 'light');
    expect(css).toContain('--ggui-spacing-4:');
    expect(css).toContain('--ggui-spacing-md:');
  });

  it('does NOT emit unconsumed groups — accessibility, zIndex and the motion ladders are layer-1 or code constants, never projected', () => {
    const css = generateCssVariables(lightTheme, 'light');
    expect(css).not.toContain('--ggui-accessibility-');
    expect(css).not.toContain('--ggui-zIndex-');
    expect(css).not.toContain('--ggui-motion-duration-');
  });

  it('wraps output in :root selector, sorted by name', () => {
    const css = generateCssVariables(lightTheme, 'light');
    expect(css.startsWith(':root {')).toBe(true);
    const names = [...css.matchAll(/^ {2}(--ggui-[^:]+):/gm)].map((m) => m[1]!);
    expect(names).toEqual([...names].sort());
  });
});

describe('parseTheme', () => {
  it('its variables are the derivation, wrapped — one producer', () => {
    const parsed = parseTheme('probe', darkTheme, 'dark');
    const derived = deriveThemeVariables(darkTheme, 'dark');
    for (const [name, value] of Object.entries(derived)) expect(parsed.cssVariables).toContain(`${name}: ${value};`);
    expect(parsed.css).toContain(parsed.cssVariables);
  });

  describe('every registered theme, both modes, is a complete projection (the v2 registration gate)', () => {
    for (const id of getThemeIds()) {
      for (const mode of ['light', 'dark'] as const) {
        it(`${id} (${mode}) derives with nothing uncovered and nothing unknown`, () => {
          const doc = getRawTheme(id, mode);
          expect(doc).toBeDefined();
          const overlay = deriveThemeVariables(doc!, mode);
          const report = validateOverlayCoverage(overlay);
          expect(report.uncovered).toEqual([]);
          expect(report.unknown).toEqual([]);
          const parsed = parseTheme(id, doc!, mode);
          expect(parsed.cssVariables).toContain(':root {');
          if (doc!.motion.keyframes && Object.keys(doc!.motion.keyframes).length > 0) expect(parsed.cssKeyframes).toContain('@keyframes ggui-');
        });
      }
    }
  });
});

describe('generateThemeReferenceDocumentation', () => {
  it('documents the derived families and the role pairs', () => {
    const doc = generateThemeReferenceDocumentation(lightTheme);
    expect(doc).toContain('## Color');
    expect(doc).toContain('var(--ggui-color-ground)');
    expect(doc).toContain('var(--ggui-color-onContainer)');
    expect(doc).toContain('## Font');
    expect(doc).toContain('## Spacing');
    expect(doc).toContain('## Shape');
    expect(doc).toContain('Material Role Pairs');
    expect(doc).not.toContain('--ggui-color-surface');
  });
});

describe('themeToCssVarReferences', () => {
  it('maps AUTHORED token paths to var() references', () => {
    const refs = themeToCssVarReferences(lightTheme);
    expect(refs['color.primary.600']).toBe('var(--ggui-color-primary-600)');
    expect(refs['color.ground']).toBe('var(--ggui-color-ground)');
  });
});

describe('the file-format path is the same producer (ggui#987 §2.4)', () => {
  it('a document with a stated link emits it as stated; an unstated link aliases primary-600', () => {
    const stated = generateCssVariables({ ...lightTheme, color: { ...lightTheme.color, link: { $value: '#123456', $type: 'color' } } }, 'light');
    expect(stated).toContain('--ggui-color-link: #123456;');
    const unstated = generateCssVariables(lightTheme, 'light');
    const primary600 = /--ggui-color-primary-600: (#[0-9a-f]{6});/.exec(unstated)?.[1];
    expect(primary600).toBeDefined();
    expect(unstated).toContain(`--ggui-color-link: ${primary600};`);
  });

  it('the flat error is the error-500 stop, in both modes', () => {
    for (const [doc, mode] of [[lightTheme, 'light'], [darkTheme, 'dark']] as const) {
      const css = generateCssVariables(doc, mode);
      const e500 = /--ggui-color-error-500: (#[0-9a-f]{6});/.exec(css)?.[1];
      expect(css).toContain(`--ggui-color-error: ${e500};`);
    }
  });
});
