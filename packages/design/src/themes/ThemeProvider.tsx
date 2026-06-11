/**
 * Theme Provider
 *
 * React Context provider for runtime theming with CSS variable injection.
 */

import React, { createContext, useContext, useMemo } from 'react';
import type { DtcgTheme } from './types';
import { generateCssVariables, themeToCssVarReferences } from './parser';
import { lightTheme } from './defaults/light';

interface ThemeContextValue {
  theme: DtcgTheme;
  cssVars: Record<string, string>;
  mode: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Hook to access theme context
 * @throws Error if used outside ThemeProvider
 */
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}

interface ThemeProviderProps {
  theme?: DtcgTheme;
  mode?: 'light' | 'dark';
  /**
   * When true, the body background is rendered as `transparent`
   * instead of the theme's `--ggui-color-surface`. Used when the
   * runtime is embedded in a host that draws its own chrome around
   * our content (claude.ai chat bubbles, Claude Desktop iframe) — a
   * solid background would create a visible card-on-card frame.
   *
   * Token-level `--ggui-color-surface` stays opaque so individual
   * surfaces (Card primitives, modal panels) still render with
   * proper contrast.
   */
  transparent?: boolean;
  children: React.ReactNode;
}

/**
 * Theme Provider component
 *
 * Injects CSS variables into document and provides theme context to children.
 *
 * @example
 * ```tsx
 * import { ThemeProvider, lightTheme } from '@ggui-ai/design/themes';
 *
 * function App() {
 *   return (
 *     <ThemeProvider theme={lightTheme} mode="light">
 *       <YourApp />
 *     </ThemeProvider>
 *   );
 * }
 * ```
 */
export function ThemeProvider({
  theme = lightTheme,
  mode = 'light',
  transparent = false,
  children,
}: ThemeProviderProps) {
  const value = useMemo(
    () => ({
      theme,
      cssVars: themeToCssVarReferences(theme),
      mode,
    }),
    [theme, mode]
  );

  const cssVarsString = useMemo(() => generateCssVariables(theme), [theme]);

  // Inject CSS variables + base body rules into document.
  //
  // The variables block emits `:root { --ggui-*: value; }`; the base
  // block immediately after wires the variables onto `html, body` so
  // unstyled text picks up the theme's font family + foreground color
  // out of the box. Without this, every consumer would have to re-
  // declare `font-family: var(--ggui-font-family-sans)` on its own
  // root, and any iframe shell that doesn't (e.g. the iframe-runtime's
  // self-contained system-card boot) renders in the user agent's
  // default serif.
  //
  // `mode === 'dark'` exposed as `color-scheme: dark` so native form
  // controls (scrollbars, date pickers) match the theme without
  // requiring per-element overrides.
  React.useEffect(() => {
    const styleId = 'ggui-theme-vars';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement;

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }

    // When `transparent` is true, the body bg drops out entirely so
    // the host's surface (a Claude chat bubble, a Studio panel) shows
    // through. We DON'T null-out `--ggui-color-surface` so cards/
    // panels inside still draw their own opaque surfaces — that's
    // the visual layering we want: transparent canvas, opaque cards.
    const bodyBackground = transparent
      ? 'transparent'
      : 'var(--ggui-color-surface, #ffffff)';
    const baseRules = `
html, body {
  margin: 0;
  font-family: var(--ggui-font-family-sans, system-ui, -apple-system, sans-serif);
  background: ${bodyBackground};
  color: var(--ggui-color-onSurface, #111827);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color-scheme: ${mode};
}
code, pre, kbd, samp {
  font-family: var(--ggui-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
*, *::before, *::after {
  box-sizing: border-box;
}
`;
    styleEl.textContent = `${cssVarsString}\n${baseRules}`;

    return () => {
      styleEl?.remove();
    };
  }, [cssVarsString, mode, transparent]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
