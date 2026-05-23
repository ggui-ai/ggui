import { describe, it, expect } from 'vitest';
import {
  generateCssVariables,
  generateThemeReferenceDocumentation,
  parseTheme,
} from './parser';
import { lightTheme } from './defaults/light';

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
