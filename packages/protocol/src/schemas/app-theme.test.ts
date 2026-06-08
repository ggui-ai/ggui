import { describe, it, expect } from 'vitest';
import { appThemeSchema, type AppTheme } from './app-theme.js';

describe('appThemeSchema', () => {
  const valid: AppTheme = {
    mode: 'dark',
    cssVariables: { '--ggui-color-primary-600': '#7c3aed', '--ggui-shape-radius-md': '12px' },
    name: 'ocean',
  };
  it('accepts a well-formed theme', () => {
    expect(appThemeSchema.safeParse(valid).success).toBe(true);
  });
  it('accepts without the optional name', () => {
    const { name: _omit, ...rest } = valid;
    expect(appThemeSchema.safeParse(rest).success).toBe(true);
  });
  it('rejects a non-ggui css-var key (no foreign custom properties)', () => {
    expect(appThemeSchema.safeParse({ ...valid, cssVariables: { '--evil-x': 'red' } }).success).toBe(false);
  });
  it('rejects an injection value (CSS rule breakout)', () => {
    expect(appThemeSchema.safeParse({ ...valid, cssVariables: { '--ggui-color-primary-600': 'red; } :root { background: url(x)' } }).success).toBe(false);
  });
  it('rejects values containing } < > @ or comment markers', () => {
    for (const bad of ['a}b', 'a<b', 'a>b', 'a@b', 'a/*b', 'a;b']) {
      expect(appThemeSchema.safeParse({ ...valid, cssVariables: { '--ggui-x': bad } }).success, `value ${JSON.stringify(bad)} must be rejected`).toBe(false);
    }
  });
  it('rejects an invalid mode', () => {
    expect(appThemeSchema.safeParse({ ...valid, mode: 'sepia' }).success).toBe(false);
  });
  it('caps the number of variables', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 201; i++) many[`--ggui-x-${i}`] = '1px';
    expect(appThemeSchema.safeParse({ ...valid, cssVariables: many }).success).toBe(false);
  });
});
