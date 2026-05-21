import { describe, expect, it } from 'vitest';

import {
  getDefaultThemeId,
  getRawTheme,
  getTheme,
  getThemeIds,
  listThemes,
} from './registry';

describe('theme registry — dual-mode shape', () => {
  it('returns light variant by default', () => {
    const t = getTheme('ggui');
    expect(t).toBeDefined();
    expect(t?.id).toBe('ggui');
  });

  it('returns light variant when mode === "light" is explicit', () => {
    const t = getTheme('ggui', 'light');
    expect(t).toBeDefined();
    expect(t?.id).toBe('ggui');
  });

  it('every registered preset ships distinct light + dark variants (Slice 2 closed)', () => {
    // Slice 2 closed the dual-mode migration: every legacy preset
    // (ggui, premium-cyberpunk, premium-zen, premium-neon-noir,
    // premium-botanical) now ships dark alongside Claudic. The fallback
    // rule (dark → light when missing) still exists in `resolveMode`,
    // but no registered preset exercises it — verified here by
    // asserting each preset's parsed CSS differs between modes.
    for (const id of getThemeIds()) {
      const light = getTheme(id, 'light');
      const dark = getTheme(id, 'dark');
      expect(light, `${id} light`).toBeDefined();
      expect(dark, `${id} dark`).toBeDefined();
      expect(dark?.css, `${id} dark CSS must differ from light`).not.toBe(
        light?.css
      );
    }
  });

  it('returns undefined for an unregistered theme id (any mode)', () => {
    expect(getTheme('does-not-exist')).toBeUndefined();
    expect(getTheme('does-not-exist', 'dark')).toBeUndefined();
  });

  it('every registered preset advertises modes ["light","dark"]', () => {
    const entries = listThemes();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.modes, `${entry.id} modes`).toEqual(
        expect.arrayContaining(['light', 'dark'])
      );
      expect(entry.modes.length, `${entry.id} mode count`).toBe(2);
    }
  });

  it('omits omo-bot from the registry', () => {
    expect(getTheme('omo-bot')).toBeUndefined();
    expect(getThemeIds()).not.toContain('omo-bot');
    expect(listThemes().some((e) => e.id === 'omo-bot')).toBe(false);
  });

  it('omits the retired "signature" id (renamed twice — first to "ggui", then a second incarnation to "indigo")', () => {
    expect(getTheme('signature')).toBeUndefined();
    expect(getThemeIds()).not.toContain('signature');
  });

  it('caches parsed themes per (id, mode) — repeated calls return the same instance', () => {
    const a = getTheme('ggui', 'light');
    const b = getTheme('ggui', 'light');
    expect(a).toBe(b);
  });

  it('exposes the raw DtcgTheme for the requested mode (with light fallback)', () => {
    const raw = getRawTheme('ggui', 'dark');
    expect(raw).toBeDefined();
    // Same fallback rule — until dark exists, raw resolves to the light shape.
    expect(raw?.$name).toBeDefined();
  });

  it('default theme id is "ggui"', () => {
    expect(getDefaultThemeId()).toBe('ggui');
  });

  describe('ggui preset (dual-mode, default)', () => {
    it('registers light and dark variants', () => {
      const light = getTheme('ggui', 'light');
      const dark = getTheme('ggui', 'dark');
      expect(light).toBeDefined();
      expect(dark).toBeDefined();
    });

    it('produces distinct CSS for light vs dark', () => {
      const light = getTheme('ggui', 'light');
      const dark = getTheme('ggui', 'dark');
      expect(light?.css).not.toBe(dark?.css);
    });

    it('lists "ggui" with modes ["light","dark"]', () => {
      const entry = listThemes().find((e) => e.id === 'ggui');
      expect(entry).toBeDefined();
      expect(entry?.modes).toEqual(expect.arrayContaining(['light', 'dark']));
      expect(entry?.modes.length).toBe(2);
    });

    it('exposes ink (#292929) at primary-500 in light mode', () => {
      const raw = getRawTheme('ggui', 'light');
      const primary500 = raw?.color.primary['500'];
      expect(primary500?.$value).toBe('#292929');
    });

    it('inverts primary-500 to paper (#f4f3ed) in dark mode', () => {
      const raw = getRawTheme('ggui', 'dark');
      const primary500 = raw?.color.primary['500'];
      // Dark inverts: paper-as-CTA on ink-base canvas.
      expect(primary500?.$value).toBe('#f4f3ed');
    });

    it('emits canvas mode "none" (GGUI is flat — no decorative flourish)', () => {
      const light = getTheme('ggui', 'light');
      const dark = getTheme('ggui', 'dark');
      expect(light?.canvasConfig.mode).toBe('none');
      expect(dark?.canvasConfig.mode).toBe('none');
    });
  });

  describe('indigo preset (dual-mode)', () => {
    it('registers light and dark variants', () => {
      const light = getTheme('indigo', 'light');
      const dark = getTheme('indigo', 'dark');
      expect(light).toBeDefined();
      expect(dark).toBeDefined();
    });

    it('produces distinct CSS for light vs dark', () => {
      const light = getTheme('indigo', 'light');
      const dark = getTheme('indigo', 'dark');
      expect(light?.css).not.toBe(dark?.css);
    });

    it('lists "indigo" with modes ["light","dark"]', () => {
      const entry = listThemes().find((e) => e.id === 'indigo');
      expect(entry).toBeDefined();
      expect(entry?.modes).toEqual(expect.arrayContaining(['light', 'dark']));
      expect(entry?.modes.length).toBe(2);
    });

    it('advertises the human-facing $name "Indigo" on the raw DTCG theme', () => {
      expect(getRawTheme('indigo', 'light')?.$name).toBe('Indigo');
      expect(getRawTheme('indigo', 'dark')?.$name).toBe('Indigo');
    });
  });

  describe('claudic preset (dual-mode)', () => {
    it('registers light and dark variants', () => {
      const light = getTheme('claudic', 'light');
      const dark = getTheme('claudic', 'dark');
      expect(light).toBeDefined();
      expect(dark).toBeDefined();
    });

    it('produces distinct CSS for light vs dark (no fallback collapse)', () => {
      const light = getTheme('claudic', 'light');
      const dark = getTheme('claudic', 'dark');
      // Unlike single-mode presets where dark falls back to light, claudic
      // ships both — the parsed CSS must actually differ.
      expect(light?.css).not.toBe(dark?.css);
    });

    it('lists "claudic" with modes ["light","dark"]', () => {
      const entry = listThemes().find((e) => e.id === 'claudic');
      expect(entry).toBeDefined();
      expect(entry?.modes).toEqual(expect.arrayContaining(['light', 'dark']));
      expect(entry?.modes.length).toBe(2);
    });

    it('exposes Crail (#cc785c) at primary-500 in light mode', () => {
      const raw = getRawTheme('claudic', 'light');
      const primary500 = raw?.color.primary['500'];
      expect(primary500?.$value).toBe('#cc785c');
    });

    it('emits canvas mode "none" (Claudic is quiet)', () => {
      const light = getTheme('claudic', 'light');
      const dark = getTheme('claudic', 'dark');
      expect(light?.canvasConfig.mode).toBe('none');
      expect(dark?.canvasConfig.mode).toBe('none');
    });
  });
});
