/**
 * ggui#1495 — a near-neutral anchor's light stops take the GROUND's hue. A near-black accent carries a trace of
 * chroma whose hue is noise; synthesising its tints at that hue painted a sampled host's hello band `#e7e8ea` (a cool
 * grey, hue ≈ 264°) on a warm cream host. Below `NEUTRAL_ANCHOR_CHROMA` the light stops (50 … 400) are the ground
 * mixed toward the anchor, at each stop's scale lightness and the ground's hue; the dark stops, and every chromatic
 * anchor, are unchanged — pinned here by the stock themes' derivations, byte for byte.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NEUTRAL_ANCHOR_CHROMA, deriveThemeVariables, hexToOklch } from './derive-theme-variables';
import { getRawTheme, getThemeIds } from './registry';
import type { DtcgTheme, DtcgToken } from './types';

const tok = (hex: string): DtcgToken => ({ $value: hex, $type: 'color' });
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** A host's saved theme as sampled on its served hello: accent `#0e1014` on canvas `#f6f5ee`, surface `#ffffff`. */
function sampledHost(): DtcgTheme {
  const base = getRawTheme('ggui')!;
  const c = base.color;
  return {
    ...base,
    color: {
      primary: { '500': tok('#0e1014') },
      success: c.success,
      warning: c.warning,
      error: c.error,
      info: c.info,
      ground: tok('#f6f5ee'),
      onGround: tok('#0e1014'),
      container: tok('#ffffff'),
      onContainer: tok('#0e1014'),
      sunken: c.sunken,
      onSunken: c.onSunken,
    },
  };
}

describe('ggui#1495 — a near-neutral anchor takes the host\'s temperature', () => {
  it('the threshold is pinned, and the sampled accent sits under it', () => {
    expect(NEUTRAL_ANCHOR_CHROMA).toBe(0.02);
    expect(hexToOklch('#0e1014').c).toBeLessThan(NEUTRAL_ANCHOR_CHROMA);
  });

  it("the hello band (primaryContainer = heroGround on a light host) and every light stop read at the ground's hue, not the accent's noise hue", () => {
    const v = deriveThemeVariables(sampledHost(), 'light');
    const groundHue = hexToOklch('#f6f5ee').h;
    const noiseHue = hexToOklch('#0e1014').h;
    for (const key of ['primaryContainer', 'heroGround', 'primary-50', 'primary-100', 'primary-200', 'primary-300', 'primary-400']) {
      const h = hexToOklch(v[`--ggui-color-${key}`]!).h;
      expect(hueGap(h, groundHue), key).toBeLessThan(2);
      expect(hueGap(h, noiseHue), key).toBeGreaterThan(90);
    }
  });

  it('the dark stops do not depend on the ground (only the light stops take its temperature)', () => {
    // At this chroma the anchor's hue is noise even after hex rounding, so the dark stops are pinned by what they must
    // NOT depend on: the same document on a warm ground and on a cool one derives identical dark stops.
    const warm = sampledHost();
    const cool: DtcgTheme = { ...warm, color: { ...warm.color, ground: tok('#eef2f6') } };
    const vw = deriveThemeVariables(warm, 'light');
    const vc = deriveThemeVariables(cool, 'light');
    for (const stop of ['600', '700', '800', '900']) {
      expect(vw[`--ggui-color-primary-${stop}`], stop).toBe(vc[`--ggui-color-primary-${stop}`]);
    }
    expect(vw['--ggui-color-primary-100']).not.toBe(vc['--ggui-color-primary-100']);
  });

  it('a chromatic anchor is untouched: its light stops stay at its own hue on the same warm ground', () => {
    const doc = sampledHost();
    const v = deriveThemeVariables({ ...doc, color: { ...doc.color, primary: { '500': tok('#4f46e5') } } }, 'light');
    const anchorHue = hexToOklch('#4f46e5').h;
    for (const stop of ['50', '100', '200', '300', '400']) {
      expect(hueGap(hexToOklch(v[`--ggui-color-primary-${stop}`]!).h, anchorHue), stop).toBeLessThan(3);
    }
  });

  it('every stock theme derives byte for byte as it did before the rule (digests taken on the derivation before ggui#1495)', () => {
    const BEFORE: Readonly<Record<string, string>> = {
      'ggui/light': '61d4bf60aa9b21ad',
      'ggui/dark': '53b744d3c0385984',
      'indigo/light': 'd1dec01a72b2cecb',
      'indigo/dark': '8920e633d8261da6',
      'claudic/light': 'f6d559f50e5b058a',
      'claudic/dark': '9cd34886e8315b3f',
      'premium-cyberpunk/light': '682e546e2d0939c3',
      'premium-cyberpunk/dark': '7200d5bf1d46aac9',
      'premium-zen/light': '29069da50acdf22c',
      'premium-zen/dark': 'd2a8cd2a6958d550',
      'premium-neon-noir/light': '3f15329cc9e7031b',
      'premium-neon-noir/dark': 'f45220405a05078e',
      'premium-botanical/light': 'f39c69dd44657323',
      'premium-botanical/dark': '658f4803ea05c3e6',
      'guuey-brand-v1/light': 'd13384d05e11ee3a',
      'guuey-brand-v1/dark': '46cbd49635b8a0b0',
    };
    const now: Record<string, string> = {};
    for (const id of getThemeIds()) {
      for (const mode of ['light', 'dark'] as const) {
        const v = deriveThemeVariables(getRawTheme(id)!, mode);
        const canon = JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
        now[`${id}/${mode}`] = createHash('sha256').update(canon).digest('hex').slice(0, 16);
      }
    }
    expect(now).toEqual(BEFORE);
  });
});
