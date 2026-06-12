/**
 * Type-level tests for the public `DtcgTheme` surface.
 *
 * These tests run under Vitest like normal tests, but they exercise the
 * TYPE system at compile time — not runtime behavior. A regression
 * here is a SILENT BREAKING CHANGE for downstream consumers (anyone
 * authoring a theme literal against the published `@ggui-ai/design`
 * type would suddenly typecheck differently). Failures show up as
 * tsc errors in the design package's `typecheck` script, not as test
 * failures.
 *
 * Use Vitest's `expectTypeOf` (zero new deps; same runner as the rest
 * of the suite). Each assertion is COMPILE-TIME-only; runtime is a
 * no-op pass.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type {
  DtcgTheme,
  DtcgToken,
  ParsedTheme,
  ThemeEntry,
  ThemeMode,
  ThemeRegistration,
} from './types';
import { lightTheme } from './defaults/light';
import { darkTheme } from './defaults/dark';

describe('DtcgToken shape stability', () => {
  it('has $value, $type, $description?', () => {
    expectTypeOf<DtcgToken>().toEqualTypeOf<{
      $value: string;
      $type: string;
      $description?: string | undefined;
    }>();
  });

  it('$value is generic — number, array, etc. allowed', () => {
    expectTypeOf<DtcgToken<number>>().toMatchTypeOf<{ $value: number }>();
    expectTypeOf<DtcgToken<string[]>>().toMatchTypeOf<{ $value: string[] }>();
  });
});

describe('DtcgTheme required fields', () => {
  it('has $name + $description required, $metadata optional', () => {
    expectTypeOf<DtcgTheme['$name']>().toBeString();
    expectTypeOf<DtcgTheme['$description']>().toBeString();
    expectTypeOf<DtcgTheme>().toHaveProperty('$metadata');
  });

  it('has color, font, spacing, shape, motion, accessibility, zIndex', () => {
    expectTypeOf<DtcgTheme>().toHaveProperty('color');
    expectTypeOf<DtcgTheme>().toHaveProperty('font');
    expectTypeOf<DtcgTheme>().toHaveProperty('spacing');
    expectTypeOf<DtcgTheme>().toHaveProperty('shape');
    expectTypeOf<DtcgTheme>().toHaveProperty('motion');
    expectTypeOf<DtcgTheme>().toHaveProperty('accessibility');
    expectTypeOf<DtcgTheme>().toHaveProperty('zIndex');
  });

  it('semantic colors success/warning/error/info are SCALES (Records), not singletons', () => {
    expectTypeOf<DtcgTheme['color']['success']>().toEqualTypeOf<
      Record<string, DtcgToken>
    >();
    expectTypeOf<DtcgTheme['color']['warning']>().toEqualTypeOf<
      Record<string, DtcgToken>
    >();
    expectTypeOf<DtcgTheme['color']['error']>().toEqualTypeOf<
      Record<string, DtcgToken>
    >();
    expectTypeOf<DtcgTheme['color']['info']>().toEqualTypeOf<
      Record<string, DtcgToken>
    >();
  });

  it('primary + neutral are SCALES', () => {
    expectTypeOf<DtcgTheme['color']['primary']>().toEqualTypeOf<
      Record<string, DtcgToken>
    >();
    expectTypeOf<DtcgTheme['color']['neutral']>().toEqualTypeOf<
      Record<string, DtcgToken>
    >();
  });

  it('Material 3 role-pair singletons are present', () => {
    expectTypeOf<DtcgTheme['color']['surface']>().toEqualTypeOf<DtcgToken>();
    expectTypeOf<DtcgTheme['color']['onSurface']>().toEqualTypeOf<DtcgToken>();
    expectTypeOf<DtcgTheme['color']['surfaceVariant']>().toEqualTypeOf<DtcgToken>();
    expectTypeOf<DtcgTheme['color']['onSurfaceVariant']>().toEqualTypeOf<DtcgToken>();
    expectTypeOf<DtcgTheme['color']['container']>().toEqualTypeOf<DtcgToken>();
    expectTypeOf<DtcgTheme['color']['onContainer']>().toEqualTypeOf<DtcgToken>();
    expectTypeOf<DtcgTheme['color']['outline']>().toEqualTypeOf<DtcgToken>();
    expectTypeOf<DtcgTheme['color']['outlineVariant']>().toEqualTypeOf<DtcgToken>();
  });

  it('motion has duration + easing + transition + keyframes records', () => {
    expectTypeOf<DtcgTheme['motion']>().toHaveProperty('duration');
    expectTypeOf<DtcgTheme['motion']>().toHaveProperty('easing');
    expectTypeOf<DtcgTheme['motion']>().toHaveProperty('transition');
    expectTypeOf<DtcgTheme['motion']>().toHaveProperty('keyframes');
    expectTypeOf<DtcgTheme['motion']['duration']>().toEqualTypeOf<
      Record<string, DtcgToken>
    >();
    expectTypeOf<DtcgTheme['motion']['transition']>().toEqualTypeOf<
      Record<string, DtcgToken>
    >();
  });

  it('accessibility has focusRing + reducedMotion + highContrast', () => {
    expectTypeOf<DtcgTheme['accessibility']>().toHaveProperty('focusRing');
    expectTypeOf<DtcgTheme['accessibility']>().toHaveProperty('reducedMotion');
    expectTypeOf<DtcgTheme['accessibility']>().toHaveProperty('highContrast');
    expectTypeOf<DtcgTheme['accessibility']['focusRing']>().toHaveProperty('color');
    expectTypeOf<DtcgTheme['accessibility']['focusRing']>().toHaveProperty('width');
    expectTypeOf<DtcgTheme['accessibility']['focusRing']>().toHaveProperty('offset');
  });

  it('zIndex is Record<string, DtcgToken<number>> — number-typed', () => {
    expectTypeOf<DtcgTheme['zIndex']>().toEqualTypeOf<
      Record<string, DtcgToken<number>>
    >();
  });
});

describe('Shipped default themes structurally match DtcgTheme', () => {
  it('lightTheme is assignable to DtcgTheme', () => {
    expectTypeOf(lightTheme).toMatchTypeOf<DtcgTheme>();
  });

  it('darkTheme is assignable to DtcgTheme', () => {
    expectTypeOf(darkTheme).toMatchTypeOf<DtcgTheme>();
  });
});

describe('Supporting types', () => {
  it('ThemeMode is the string union', () => {
    expectTypeOf<ThemeMode>().toEqualTypeOf<'light' | 'dark'>();
  });

  it('ThemeRegistration light required, dark optional', () => {
    expectTypeOf<ThemeRegistration['light']>().toEqualTypeOf<DtcgTheme>();
    expectTypeOf<ThemeRegistration['dark']>().toEqualTypeOf<DtcgTheme | undefined>();
  });

  it('ParsedTheme exposes the canonical output shape', () => {
    expectTypeOf<ParsedTheme>().toHaveProperty('id');
    expectTypeOf<ParsedTheme>().toHaveProperty('name');
    expectTypeOf<ParsedTheme>().toHaveProperty('cssVariables');
    expectTypeOf<ParsedTheme>().toHaveProperty('cssKeyframes');
    expectTypeOf<ParsedTheme>().toHaveProperty('css');
  });

  it('ThemeEntry surfaces registry metadata only (no full theme)', () => {
    expectTypeOf<ThemeEntry>().toHaveProperty('id');
    expectTypeOf<ThemeEntry>().toHaveProperty('name');
    expectTypeOf<ThemeEntry>().toHaveProperty('description');
    expectTypeOf<ThemeEntry>().toHaveProperty('modes');
    expectTypeOf<ThemeEntry['modes']>().toEqualTypeOf<readonly ThemeMode[]>();
  });
});

describe('Negative cases — known-bad shapes should be rejected', () => {
  it('rejects a theme with success as a singleton DtcgToken (post-consolidation; only scales)', () => {
    type BadTheme = Omit<DtcgTheme, 'color'> & {
      color: Omit<DtcgTheme['color'], 'success'> & { success: DtcgToken };
    };
    // @ts-expect-error — singleton success is no longer assignable to the scale-only DtcgTheme.color.success
    const _bad: DtcgTheme = {} as BadTheme;
    void _bad;
  });

  it('rejects a theme missing zIndex', () => {
    type BadTheme = Omit<DtcgTheme, 'zIndex'>;
    // @ts-expect-error — zIndex is REQUIRED at the top level.
    const _bad: DtcgTheme = {} as BadTheme;
    void _bad;
  });

  it('rejects a theme missing accessibility', () => {
    type BadTheme = Omit<DtcgTheme, 'accessibility'>;
    // @ts-expect-error — accessibility is REQUIRED at the top level.
    const _bad: DtcgTheme = {} as BadTheme;
    void _bad;
  });

  it('rejects a theme missing motion.transition', () => {
    type BadTheme = Omit<DtcgTheme, 'motion'> & {
      motion: Omit<DtcgTheme['motion'], 'transition'>;
    };
    // @ts-expect-error — motion.transition is REQUIRED.
    const _bad: DtcgTheme = {} as BadTheme;
    void _bad;
  });
});
