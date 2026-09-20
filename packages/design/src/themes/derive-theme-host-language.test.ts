/**
 * Pin (ggui#1093 R1): the host design language's DOCUMENT members reach the
 * card through the ONE projection — and only through tokens the card already
 * reads. `typeScale` moves the type scale, `rhythm.base` re-derives the
 * spacing scale, and a document that states neither is BYTE-IDENTICAL to one
 * written before the members existed (INVARIANT 1, the design-side twin of
 * protocol's door-side pin).
 *
 * The role-NAMED families (`--ggui-font-size-h1`, `--ggui-scrim-*`) are
 * deliberately NOT emitted here: the manifest is the set of variables a card
 * consumes, derived by scanning the primitives, so a family enters it with
 * its consumer (#1075 Track C (b) for the roles, #1083 for the scrim) and
 * never before.
 */
import { describe, it, expect } from 'vitest';
import { deriveThemeVariables } from './derive-theme-variables';
import { lightTheme } from './defaults/light';
import type { DtcgTheme } from './types';

const px = (v: string) => ({ $value: v, $type: 'dimension' });
/** A RATIO token — `leading` is the only member typed `DtcgToken<number>` (ggui#1093 P1b). */
const ratio = (v: number) => ({ $value: v, $type: 'number' });
/** Every other token carries a STRING `$value`, weights included — `DtcgToken` is `DtcgToken<string>`. */
const token = (v: string) => ({ $value: v, $type: 'fontWeight' });

function withMembers(extra: Partial<DtcgTheme>): DtcgTheme {
  return { ...lightTheme, ...extra } as DtcgTheme;
}

describe('the host design language reaches the card (ggui#1093 R1)', () => {
  it('INVARIANT 1: a document stating neither member derives byte-identically to today', () => {
    const before = deriveThemeVariables(lightTheme, 'light');
    const after = deriveThemeVariables(withMembers({}), 'light');
    expect(after).toEqual(before);
    // An EMPTY group is not a statement either.
    expect(deriveThemeVariables(withMembers({ typeScale: {} }), 'light')).toEqual(before);
  });

  it('rhythm.base re-derives the whole spacing scale in the host unit, and OUTRANKS the document\'s own stops', () => {
    const base = deriveThemeVariables(lightTheme, 'light');
    // The default theme states its own stops — which is exactly why the
    // scale-level statement has to outrank them, or the member is inert.
    expect(base['--ggui-spacing-4']).toBe('1rem');

    const v = deriveThemeVariables(withMembers({ rhythm: { base: px('6px') } }), 'light');
    expect(v['--ggui-spacing-1']).toBe('6px');
    expect(v['--ggui-spacing-4']).toBe('24px'); // 16/4 × 6
    expect(v['--ggui-spacing-md']).toBe('24px');
    expect(v['--ggui-spacing-xs']).toBe('6px');
    expect(v['--ggui-spacing-2xl']).toBe('72px'); // 48/4 × 6

    // A rem rhythm keeps the host's unit rather than being re-unit'd.
    const rem = deriveThemeVariables(withMembers({ rhythm: { base: px('0.5rem') } }), 'light');
    expect(rem['--ggui-spacing-4']).toBe('2rem');

    // A document that declares BOTH gets the rhythm: the scale-level statement
    // is the intent, and a document needing a bespoke step declares no rhythm.
    const both = deriveThemeVariables(
      withMembers({ rhythm: { base: px('6px') }, spacing: { ...(lightTheme.spacing ?? {}), md: px('99px') } }),
      'light',
    );
    expect(both['--ggui-spacing-md']).toBe('24px');
    // …and with no rhythm, the stated step is untouched.
    const statedOnly = deriveThemeVariables(
      withMembers({ spacing: { ...(lightTheme.spacing ?? {}), md: px('99px') } }),
      'light',
    );
    expect(statedOnly['--ggui-spacing-md']).toBe('99px');
  });

  it('typeScale: body.size moves the whole scale, a stated role wins its own stop, and weight / tracking / leading land on the read tokens', () => {
    const v = deriveThemeVariables(
      withMembers({
        typeScale: {
          body: { size: px('18px'), weight: token('450'), tracking: px('0.01em'), leading: ratio(1.6) },
          h1: { size: px('44px'), weight: token('800'), tracking: px('-0.03em') },
        },
      }),
      'light',
    );
    expect(v['--ggui-font-size-base']).toBe('18px'); // the host's body copy IS the base
    expect(v['--ggui-font-size-3xl']).toBe('44px'); // h1 wins its stop outright
    expect(v['--ggui-font-weight-heading']).toBe('800');
    expect(v['--ggui-font-weight-normal']).toBe('450');
    expect(v['--ggui-letter-spacing-heading']).toBe('-0.03em');
    expect(v['--ggui-font-lineHeight-normal']).toBe('1.6');
    // An UNSTATED role falls to the ramp rather than blanking: a harvest that
    // measured only body and h1 still produces every stop.
    const base = deriveThemeVariables(lightTheme, 'light');
    expect(v['--ggui-font-size-xs']).not.toBe(base['--ggui-font-size-xs']);
    expect(v['--ggui-font-size-xs']).toMatch(/^[0-9.]+px$/);
  });

  it('the scrim reaches the card (ggui#1083: tint + opacity, never blur); the role-named families are NOT emitted yet (their consumer does not exist)', () => {
    const v = deriveThemeVariables(
      withMembers({
        scrim: { tone: 'dark', opacity: ratio(0.7), blur: px('16px') },
        typeScale: { h1: { size: px('40px') } },
      }),
      'light',
    );
    expect(v['--ggui-scrim-tint']).toBe('#000000');
    expect(v['--ggui-scrim-opacity']).toBe('0.7');
    expect(Object.keys(v).filter((k) => k.startsWith('--ggui-scrim-')).sort()).toEqual(['--ggui-scrim-opacity', '--ggui-scrim-tint']);
    expect(v['--ggui-font-size-h1']).toBeUndefined();
    // …and stating them never breaks the derivation.
    expect(v['--ggui-font-size-3xl']).toBe('40px');
  });
});
