import { describe, it, expect } from 'vitest';
import {
  generateCssVariables,
  generateThemeReferenceDocumentation,
  parseTheme,
} from './parser';
import { lightTheme } from './defaults/light';
import { getRawTheme, getThemeIds } from './registry';
import type { ThemeMode } from './types';

describe('generateCssVariables', () => {
  it('generates CSS variables for color tokens', () => {
    const css = generateCssVariables(lightTheme);
    expect(css).toContain('--ggui-color-primary-600: #0284c7');
    expect(css).toContain('--ggui-color-neutral-900: #111827');
  });

  it('emits semantic role pairs', () => {
    const css = generateCssVariables(lightTheme);
    expect(css).toContain('--ggui-color-surface: #ffffff');
    expect(css).toContain('--ggui-color-onSurface: #111827');
    expect(css).toContain('--ggui-color-onSurfaceVariant: #6b7280');
  });

  it('generates CSS variables for spacing tokens', () => {
    const css = generateCssVariables(lightTheme);
    expect(css).toContain('--ggui-spacing-md: 16px');
  });

  it('generates CSS variables for accessibility tokens', () => {
    const css = generateCssVariables(lightTheme);
    expect(css).toContain('--ggui-accessibility-focusRing-color: #0284c7');
    expect(css).toContain('--ggui-accessibility-focusRing-width: 2px');
    expect(css).toContain('--ggui-accessibility-focusRing-offset: 2px');
    expect(css).toContain('--ggui-accessibility-reducedMotion-duration: 0ms');
    expect(css).toContain('--ggui-accessibility-highContrast-borderWidth: 2px');
  });

  it('generates CSS variables for zIndex tokens', () => {
    const css = generateCssVariables(lightTheme);
    expect(css).toContain('--ggui-zIndex-modal: 1400');
    expect(css).toContain('--ggui-zIndex-tooltip: 1800');
  });

  it('wraps output in :root selector', () => {
    const css = generateCssVariables(lightTheme);
    expect(css).toMatch(/^:root \{/);
    expect(css).toMatch(/\}$/);
  });
});

describe('parseTheme', () => {
  it('emits the same canonical CSS vars as the duck-typed walker for DtcgTheme inputs', () => {
    const parsed = parseTheme('default', lightTheme);
    expect(parsed.cssVariables).toContain('--ggui-color-onSurface: #111827');
    expect(parsed.cssVariables).toContain('--ggui-motion-transition-fast');
    expect(parsed.cssVariables).toContain('--ggui-shape-radius-md: 8px');
    expect(parsed.canvasConfig.mode).toBe('none');
  });

  // Shape-conformance gate across every registered theme × every mode.
  // Catches a premium theme drifting from the canonical DtcgTheme shape
  // before it ships — without this, a missing `accessibility` or
  // `motion.transition` block only surfaces at render time, not test time.
  describe('shape conformance across every registered theme', () => {
    const themeIds = getThemeIds();
    const modes: readonly ThemeMode[] = ['light', 'dark'];

    for (const id of themeIds) {
      for (const mode of modes) {
        it(`${id} (${mode}) parses + emits every required token group`, () => {
          const raw = getRawTheme(id, mode);
          expect(raw, `getRawTheme(${id}, ${mode}) returned undefined`).toBeDefined();
          const parsed = parseTheme(id, raw!);

          // Required emission groups — every canonical DtcgTheme must
          // ship all of these. Premium themes that override durations or
          // semantic-color stops still emit under these prefixes.
          expect(parsed.cssVariables).toContain('--ggui-color-primary-500');
          expect(parsed.cssVariables).toContain('--ggui-color-neutral-500');
          expect(parsed.cssVariables).toContain('--ggui-color-success-500');
          expect(parsed.cssVariables).toContain('--ggui-color-warning-500');
          expect(parsed.cssVariables).toContain('--ggui-color-error-500');
          expect(parsed.cssVariables).toContain('--ggui-color-info-500');
          expect(parsed.cssVariables).toContain('--ggui-color-surface');
          expect(parsed.cssVariables).toContain('--ggui-color-onSurface');
          expect(parsed.cssVariables).toContain('--ggui-color-outline');
          // Material 3 role pairs — primary / error / tertiary families.
          // Every theme MUST ship a foreground for each tinted surface so
          // the LLM never has to invent contrast colors.
          expect(parsed.cssVariables).toContain('--ggui-color-onPrimary');
          expect(parsed.cssVariables).toContain('--ggui-color-primaryContainer');
          expect(parsed.cssVariables).toContain('--ggui-color-onPrimaryContainer');
          expect(parsed.cssVariables).toContain('--ggui-color-onError');
          expect(parsed.cssVariables).toContain('--ggui-color-errorContainer');
          expect(parsed.cssVariables).toContain('--ggui-color-onErrorContainer');
          expect(parsed.cssVariables).toContain('--ggui-color-tertiary');
          expect(parsed.cssVariables).toContain('--ggui-color-onTertiary');
          expect(parsed.cssVariables).toContain('--ggui-color-tertiaryContainer');
          expect(parsed.cssVariables).toContain('--ggui-color-onTertiaryContainer');
          expect(parsed.cssVariables).toContain('--ggui-font-family-sans');
          expect(parsed.cssVariables).toContain('--ggui-shape-radius-');
          expect(parsed.cssVariables).toContain('--ggui-shape-shadow-');
          expect(parsed.cssVariables).toContain('--ggui-motion-duration-');
          expect(parsed.cssVariables).toContain('--ggui-motion-transition-');
          expect(parsed.cssVariables).toContain('--ggui-accessibility-focusRing-color');
          expect(parsed.cssVariables).toContain('--ggui-accessibility-reducedMotion-duration');
          expect(parsed.cssVariables).toContain('--ggui-accessibility-highContrast-borderWidth');
          expect(parsed.cssVariables).toContain('--ggui-zIndex-modal');
          expect(parsed.cssVariables).toContain('--ggui-zIndex-tooltip');

          // ParsedTheme metadata round-trips from the source theme.
          expect(parsed.id).toBe(id);
          expect(parsed.name).toBe(raw!.$name);
          expect(parsed.canvasConfig.mode).toBe(raw!.canvas.mode.$value);
        });
      }
    }
  });
});

describe('generateThemeReferenceDocumentation', () => {
  it('includes accessibility section', () => {
    const docs = generateThemeReferenceDocumentation(lightTheme);
    expect(docs).toContain('## Accessibility');
    expect(docs).toContain('### Focus Ring');
    expect(docs).toContain('var(--ggui-accessibility-focusRing-color)');
    expect(docs).toContain('### Reduced Motion');
    expect(docs).toContain('### High Contrast');
  });

  it('includes color documentation with both scales and singletons', () => {
    const docs = generateThemeReferenceDocumentation(lightTheme);
    expect(docs).toContain('## Colors');
    expect(docs).toContain('var(--ggui-color-primary-600)');
    expect(docs).toContain('var(--ggui-color-surface)');
  });

  it('lists transitions and shape tokens under canonical paths', () => {
    const docs = generateThemeReferenceDocumentation(lightTheme);
    expect(docs).toContain('var(--ggui-shape-radius-md)');
    expect(docs).toContain('var(--ggui-shape-shadow-md)');
    expect(docs).toContain('var(--ggui-motion-transition-normal)');
  });
});
