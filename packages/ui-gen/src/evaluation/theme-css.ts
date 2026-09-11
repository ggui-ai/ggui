import type { AppTheme } from '@ggui-ai/protocol';
import { composeThemeCss, getCssTokens } from '@ggui-ai/design/rendering';

/**
 * The stylesheet a visual judge renders under for an app: the app's theme
 * composed the way the runtime composes it (`composeThemeCss`, layer `page`
 * — one composition, never a second), so a judged canvas paints the tokens a
 * visitor's page paints. Absent theme ⇒ the design's default tokens,
 * byte-for-byte what the judge used before.
 */
export function cssTokensForAppTheme(theme: AppTheme | undefined, mode: 'light' | 'dark' = 'light'): string {
  if (theme === undefined) return getCssTokens(mode);
  return composeThemeCss({ layer: 'page', mode: theme.mode ?? mode, appTheme: theme });
}
