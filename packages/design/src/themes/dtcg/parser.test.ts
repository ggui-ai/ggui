import { describe, it, expect } from 'vitest';
import { generateCssVariables, generateCssVariableDocumentation } from './parser';
import { lightTheme } from '../defaults/light';

describe('generateCssVariables', () => {
  it('generates CSS variables for color tokens', () => {
    const css = generateCssVariables(lightTheme);
    expect(css).toContain('--ggui-color-primary-600: #0284c7');
    expect(css).toContain('--ggui-color-gray-900: #111827');
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

  it('wraps output in :root selector', () => {
    const css = generateCssVariables(lightTheme);
    expect(css).toMatch(/^:root \{/);
    expect(css).toMatch(/\}$/);
  });
});

describe('generateCssVariableDocumentation', () => {
  it('includes accessibility section', () => {
    const docs = generateCssVariableDocumentation(lightTheme);
    expect(docs).toContain('## Accessibility');
    expect(docs).toContain('### Focus Ring');
    expect(docs).toContain('var(--ggui-accessibility-focusRing-color)');
    expect(docs).toContain('### Reduced Motion');
    expect(docs).toContain('### High Contrast');
  });

  it('includes color documentation', () => {
    const docs = generateCssVariableDocumentation(lightTheme);
    expect(docs).toContain('## Colors');
    expect(docs).toContain('var(--ggui-color-primary-600)');
  });
});
