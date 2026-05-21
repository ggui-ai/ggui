/**
 * ThemeProvider — minimal root-surface theme wrapper for the web SDK.
 *
 * Prop shape mirrors the RN SDK's `<ThemeProvider colorScheme?>` so a
 * cross-platform facade can re-export a single symbol from both
 * `@ggui-ai/react` and `@ggui-ai/react-native` without type drift.
 *
 * Web theming is CSS-variable driven (see `@ggui-ai/design` DTCG tokens).
 * This component resolves the active color scheme — explicit prop wins,
 * otherwise falls back to `prefers-color-scheme` — and publishes it via
 * `data-ggui-color-scheme` on a wrapping div so consumer CSS can branch.
 *
 * Not exporting `useTheme` on web in Chunk 0. Consumers read the DTCG CSS
 * variables directly; the hook can land later if a facade consumer needs it.
 */
import { useEffect, useState, type ReactNode } from 'react';

export interface ThemeProviderProps {
  /**
   * Force a color scheme. Omit to follow `prefers-color-scheme`.
   * Matches the RN SDK's `ThemeProviderProps` exactly.
   */
  colorScheme?: 'light' | 'dark';
  children: ReactNode;
}

function resolveSystemScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ colorScheme, children }: ThemeProviderProps) {
  const [systemScheme, setSystemScheme] = useState<'light' | 'dark'>(() => resolveSystemScheme());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event: MediaQueryListEvent) => {
      setSystemScheme(event.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const effectiveScheme = colorScheme ?? systemScheme;

  return <div data-ggui-color-scheme={effectiveScheme}>{children}</div>;
}
