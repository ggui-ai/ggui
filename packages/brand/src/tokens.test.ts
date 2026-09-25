import { describe, expect, it } from 'vitest';
import { BRAND_COLORS, brandTokensCss } from './tokens.js';

describe('brand tokens', () => {
  it('are the kit v1.0 values', () => {
    expect(BRAND_COLORS).toEqual({
      paper: '#F4F3ED',
      ink: '#292929',
      chrome: '#D9D9D9',
      line2: '#D6D4CB',
      ink2: '#3D3D3D',
      ink3: '#5A5A5A',
      ink4: '#8C8C93',
    });
  });

  it('render as --ggb-* custom properties, never in the --ggui-* namespace', () => {
    const css = brandTokensCss();
    expect(css).toContain('--ggb-paper: #F4F3ED;');
    expect(css).toContain('--ggb-ink4: #8C8C93;');
    expect(css).not.toContain('--ggui-');
  });
});
