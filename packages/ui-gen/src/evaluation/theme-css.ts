import type { AppTheme } from '@ggui-ai/protocol';
import { composeThemeCss, getCssTokens } from '@ggui-ai/design/rendering';

/**
 * The stylesheet a visual judge renders under for an app: the app's theme
 * composed the way the runtime composes it (`composeThemeCss`, layer `page`
 * — one composition, never a second), so a judged canvas paints the tokens a
 * visitor's page paints. `themeId` is the registered ladder the app's theme
 * sits on (the runtime's base layer); an unknown id composes the default
 * ladder. Neither given ⇒ the design's default tokens, byte-for-byte what the
 * judge used before.
 */
export function cssTokensForAppTheme(theme: AppTheme | undefined, mode: 'light' | 'dark' = 'light', themeId?: string): string {
  if (theme === undefined && themeId === undefined) return getCssTokens(mode);
  return composeThemeCss({
    layer: 'page',
    mode: theme?.mode ?? mode,
    ...(themeId !== undefined ? { themeId } : {}),
    ...(theme !== undefined ? { appTheme: theme } : {}),
  });
}
