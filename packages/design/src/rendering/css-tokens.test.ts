import { describe, it, expect } from 'vitest';
import {
  getCssTokens,
  getScopedCssTokens,
  getThemeCss,
  getScopedThemeCss,
} from './css-tokens';

describe('getCssTokens', () => {
  it('returns CSS containing a :root block', () => {
    const css = getCssTokens();
    expect(css).toContain(':root');
  });

  it('contains --ggui-color-primary-600', () => {
    const css = getCssTokens();
    expect(css).toContain('--ggui-color-primary-600');
  });

  it('uses --ggui-color-neutral-* (legacy --ggui-color-gray-* retired)', () => {
    const css = getCssTokens();
    expect(css).toContain('--ggui-color-neutral-');
    expect(css).not.toContain('--ggui-color-gray-');
  });

  it('contains --ggui-color-info (semantic status)', () => {
    const css = getCssTokens();
    expect(css).toContain('--ggui-color-info');
  });

  it('exposes both numeric (--ggui-spacing-1) and named (--ggui-spacing-xs) spacing tokens', () => {
    // The default theme ships BOTH conventions on purpose — numeric
    // 1..12 for the existing ladder + xs/sm/md/lg/xl/2xl named aliases
    // that primitive defaults (Card.padding=lg, Stack.gap=sm, …)
    // reference. Both must be present so LLM-generated UIs using either
    // convention type-check and render.
    const css = getCssTokens();
    expect(css).toContain('--ggui-spacing-1');
    expect(css).toContain('--ggui-spacing-xs');
  });

  it('uses --ggui-font-size-* (NOT --ggui-typography-fontSize-*)', () => {
    const css = getCssTokens();
    expect(css).toContain('--ggui-font-size-');
    expect(css).not.toContain('--ggui-typography-fontSize-');
  });

  it('contains --ggui-shape-radius-*', () => {
    const css = getCssTokens();
    expect(css).toContain('--ggui-shape-radius-');
  });

  it('contains semantic surface roles', () => {
    const css = getCssTokens();
    expect(css).toContain('--ggui-color-surface');
    expect(css).toContain('--ggui-color-onSurface');
  });

  it('contains @keyframes declarations (motion)', () => {
    const css = getCssTokens();
    expect(css).toContain('@keyframes');
  });
});

describe('getScopedCssTokens', () => {
  it('replaces :root with the scope class', () => {
    const css = getScopedCssTokens('my-scope');
    expect(css).toContain('.my-scope {');
    expect(css).not.toMatch(/^:root\s*\{/m);
  });

  it('includes box-sizing reset for scope', () => {
    const css = getScopedCssTokens('my-scope');
    expect(css).toContain('.my-scope *');
    expect(css).toContain('box-sizing: border-box');
  });
});

describe('getThemeCss', () => {
  it('returns CSS for the ggui theme', () => {
    const css = getThemeCss('ggui');
    expect(css).toContain(':root');
    expect(css).toContain('--ggui-color-primary-600');
  });

  it('returns CSS for a premium theme', () => {
    const css = getThemeCss('premium-cyberpunk');
    expect(css).toContain(':root');
    expect(css).toContain('--ggui-color-primary-');
  });

  it('returns different CSS for different themes', () => {
    const ggui = getThemeCss('ggui');
    const cyberpunk = getThemeCss('premium-cyberpunk');
    expect(ggui).not.toBe(cyberpunk);
  });

  it('falls back to default theme for unknown theme ID', () => {
    const unknown = getThemeCss('nonexistent-theme');
    const defaultCss = getThemeCss('ggui');
    expect(unknown).toBe(defaultCss);
  });
});

describe('getScopedThemeCss', () => {
  it('scopes the requested theme', () => {
    const css = getScopedThemeCss('premium-cyberpunk', 'cyber');
    expect(css).toContain('.cyber {');
  });

  it('falls back to default for unknown theme', () => {
    const css = getScopedThemeCss('nonexistent', 'scope');
    expect(css).toContain('.scope {');
    expect(css).toContain('--ggui-color-primary-');
  });
});
