/**
 * React Native Theme Provider
 *
 * Provides design tokens via React Context with light/dark mode support.
 * Uses the system color scheme by default but supports explicit override.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import type { RNTheme } from './types';
import {
  rnColors,
  rnSemantic,
  rnSpacing,
  rnSpacingNamed,
  rnFontSize,
  rnFontWeight,
  rnLineHeight,
  rnFontFamily,
  rnRadius,
  rnShadow,
  rnDuration,
  rnEasing,
  rnTransition,
  rnAccessibility,
} from './tokens';

// Dark mode semantic overrides
const darkSemantic = {
  textPrimary: rnColors.gray[50],
  textSecondary: rnColors.gray[400],
  textMuted: rnColors.gray[500],
  textInverse: rnColors.gray[900],
  bgPrimary: '#0f172a',
  bgSecondary: '#1e293b',
  bgTertiary: rnColors.gray[800],
  bgInverse: rnColors.gray[50],
  borderLight: rnColors.gray[700],
  borderDefault: rnColors.gray[600],
  borderDark: rnColors.gray[500],
  focus: rnColors.primary[400],
  hover: rnColors.primary[900],
  active: rnColors.primary[800],
  disabled: rnColors.gray[600],
  success: rnColors.success[400],
  warning: rnColors.warning[400],
  error: rnColors.error[400],
  info: rnColors.info[400],
} as const;

// Dark shadow overrides (higher opacity for visibility on dark backgrounds)
const darkShadow = {
  none: rnShadow.none,
  sm: { ...rnShadow.sm, shadowOpacity: 0.3 },
  md: { ...rnShadow.md, shadowOpacity: 0.4 },
  lg: { ...rnShadow.lg, shadowOpacity: 0.4 },
  xl: { ...rnShadow.xl, shadowOpacity: 0.5 },
  '2xl': { ...rnShadow['2xl'], shadowOpacity: 0.6 },
} as const;

function buildTheme(colorScheme: 'light' | 'dark', reduceMotionEnabled = false): RNTheme {
  const isDark = colorScheme === 'dark';
  return {
    colorScheme,
    colors: rnColors,
    semantic: isDark ? darkSemantic : rnSemantic,
    spacing: rnSpacing,
    spacingNamed: rnSpacingNamed,
    fontSize: rnFontSize,
    fontWeight: rnFontWeight,
    lineHeight: rnLineHeight,
    fontFamily: rnFontFamily,
    radius: rnRadius,
    shadow: isDark ? darkShadow : rnShadow,
    duration: reduceMotionEnabled
      ? Object.fromEntries(Object.keys(rnDuration).map((k) => [k, 0]))
      : rnDuration,
    easing: rnEasing,
    transition: reduceMotionEnabled
      ? Object.fromEntries(
          Object.entries(rnTransition).map(([k, v]) => [k, { ...v, duration: 0 }])
        )
      : rnTransition,
    accessibility: rnAccessibility,
    reduceMotionEnabled,
  };
}

const ThemeContext = createContext<RNTheme | null>(null);

export interface ThemeProviderProps {
  colorScheme?: 'light' | 'dark';
  children: ReactNode;
}

/**
 * TERMINAL CONSUMER of the theme-mode ladder (adversarial-cycle
 * ruling, ggui#598 leg 4): the RN provider paints the NATIVE chrome
 * around the WebView — there is no downstream layer left to fill an
 * absent opinion, and React Native must render with SOME concrete
 * scheme. The `?? 'light'` here is therefore the documented
 * terminal-consumer default (the same posture as the design package's
 * css-tokens terminal default), NOT a mid-ladder defaulting: it fires
 * only after the embedder's explicit prop AND the OS scheme are both
 * absent (`useColorScheme()` → null, rare). Mid-ladder code — anything
 * with a layer below it — must never default; it delegates to
 * `@ggui-ai/protocol/integrations/theme-binding` and lets absence
 * propagate (the composition law).
 *
 * @internal — exported for the precedence pin; production caller is
 *   `ThemeProvider`.
 */
export function resolveNativeScheme(
  prop: 'light' | 'dark' | undefined,
  system: 'light' | 'dark' | null | undefined,
): 'light' | 'dark' {
  return prop ?? system ?? 'light';
}

export function ThemeProvider({ colorScheme: colorSchemeProp, children }: ThemeProviderProps) {
  const systemScheme = useColorScheme();
  const effectiveScheme = resolveNativeScheme(colorSchemeProp, systemScheme);
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotionEnabled)
      .catch(() => {});

    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotionEnabled,
    );
    return () => subscription.remove();
  }, []);

  const theme = useMemo(
    () => buildTheme(effectiveScheme, reduceMotionEnabled),
    [effectiveScheme, reduceMotionEnabled],
  );

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): RNTheme {
  const theme = useContext(ThemeContext);
  if (!theme) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return theme;
}

export { buildTheme };
