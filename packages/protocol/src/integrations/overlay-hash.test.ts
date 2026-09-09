import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { canonicalOverlayHash, canonicalOverlayJson } from './overlay-hash.js';

const overlays = {
  light: { '--ggui-color-primary-500': '#3355ff', '--ggui-color-ground': '#ffffff' },
  dark: { '--ggui-color-ground': '#0e1014', '--ggui-color-primary-500': '#99aaff' },
};

/** ggui#987 §6.3 — one canonical serialization, one hash, on every minter and door. */
describe('canonicalOverlayHash', () => {
  it('canonical JSON sorts keys recursively, omits absent fields, carries no whitespace', () => {
    expect(canonicalOverlayJson({ overlays })).toBe(
      '{"overlays":{"dark":{"--ggui-color-ground":"#0e1014","--ggui-color-primary-500":"#99aaff"},"light":{"--ggui-color-ground":"#ffffff","--ggui-color-primary-500":"#3355ff"}}}',
    );
  });

  it('is key-order independent', async () => {
    const a = await canonicalOverlayHash({ overlays });
    const b = await canonicalOverlayHash({
      overlays: {
        dark: { '--ggui-color-primary-500': '#99aaff', '--ggui-color-ground': '#0e1014' },
        light: { '--ggui-color-ground': '#ffffff', '--ggui-color-primary-500': '#3355ff' },
      },
    });
    expect(a).toBe(b);
  });

  it('equals sha256 of the canonical JSON (independent oracle), lowercase hex', async () => {
    const input = { overlays, cssVariables: { '--ggui-shape-radius-md': '4px' }, keyframes: { light: '@keyframes a{}' } };
    const oracle = createHash('sha256').update(canonicalOverlayJson(input), 'utf8').digest('hex');
    expect(await canonicalOverlayHash(input)).toBe(oracle);
    expect(oracle).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a changed value changes the hash; an absent optional equals an undefined one', async () => {
    const base = await canonicalOverlayHash({ overlays });
    const changed = await canonicalOverlayHash({ overlays: { ...overlays, light: { ...overlays.light, '--ggui-color-ground': '#fafafa' } } });
    expect(changed).not.toBe(base);
    expect(await canonicalOverlayHash({ overlays, cssVariables: undefined })).toBe(base);
  });
});
