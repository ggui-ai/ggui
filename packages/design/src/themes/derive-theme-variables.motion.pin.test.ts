/**
 * Pin (ggui#1106): the card's motion is read through variables, so a host's
 * tempo can REACH it. Six names — `--ggui-motion-duration-{fast,base,slow}`
 * and `--ggui-motion-easing-{standard,emphasized,exit}` — are ALWAYS emitted
 * (absent a stated override they carry the layer-1 scale from
 * `tokens/transitions.ts`), and a document's `motion.duration` /
 * `motion.easing` (the ggui#1093 P1c member, validated at the document door)
 * projects onto them verbatim, step by step: a stated `fast` moves `fast`
 * alone. RED before the projection existed (the six names were absent from
 * the manifest and from the derived set), GREEN after.
 */
import { describe, expect, it } from 'vitest';
import { deriveThemeVariables } from './derive-theme-variables.js';
import { lightTheme } from './defaults/light.js';
import { duration, easing } from '../tokens/transitions.js';
import type { DtcgTheme } from './types.js';

const NAMES = {
  fast: '--ggui-motion-duration-fast',
  base: '--ggui-motion-duration-base',
  slow: '--ggui-motion-duration-slow',
  standard: '--ggui-motion-easing-standard',
  emphasized: '--ggui-motion-easing-emphasized',
  exit: '--ggui-motion-easing-exit',
} as const;

function motionOf(vars: Readonly<Record<string, string>>): Record<keyof typeof NAMES, string | undefined> {
  return Object.fromEntries(Object.entries(NAMES).map(([k, name]) => [k, vars[name]])) as Record<keyof typeof NAMES, string | undefined>;
}

function withMotion(doc: DtcgTheme, override: Partial<DtcgTheme['motion']>): DtcgTheme {
  return { ...doc, motion: { ...doc.motion, ...override } };
}

describe('motion through variables — ggui#1106', () => {
  it('the six names are ALWAYS emitted with the layer-1 scale when the document states no tempo', () => {
    const v = deriveThemeVariables(lightTheme, 'light');
    expect(motionOf(v)).toEqual({
      fast: duration.fast,
      base: duration.normal,
      slow: duration.slow,
      standard: easing.easeInOut,
      emphasized: easing.easeOut,
      exit: easing.easeIn,
    });
    expect(motionOf(deriveThemeVariables(lightTheme, 'dark'))).toEqual(motionOf(v));
  });

  it('a stated tempo step and easing role project VERBATIM; the unstated steps keep layer-1', () => {
    const doc = withMotion(lightTheme, {
      duration: { fast: { $type: 'duration', $value: '150ms' } },
      easing: { standard: { $type: 'cubicBezier', $value: 'ease-out' }, exit: { $type: 'cubicBezier', $value: 'steps(4, end)' } },
    });
    const v = motionOf(deriveThemeVariables(doc, 'light'));
    expect(v.fast).toBe('150ms');
    expect(v.base).toBe(duration.normal);
    expect(v.slow).toBe(duration.slow);
    expect(v.standard).toBe('ease-out');
    expect(v.emphasized).toBe(easing.easeOut);
    expect(v.exit).toBe('steps(4, end)');
  });

  it('a fully stated tempo replaces every step — the host’s scale, not a blend', () => {
    const doc = withMotion(lightTheme, {
      duration: {
        fast: { $type: 'duration', $value: '80ms' },
        base: { $type: 'duration', $value: '160ms' },
        slow: { $type: 'duration', $value: '240ms' },
      },
    });
    const v = motionOf(deriveThemeVariables(doc, 'light'));
    expect([v.fast, v.base, v.slow]).toEqual(['80ms', '160ms', '240ms']);
  });
});
