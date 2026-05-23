/**
 * Theme Module Exports
 *
 * Single canonical theme surface for `@ggui-ai/design`. One shape
 * ({@link DtcgTheme}), one walker ({@link parseTheme}), one registry.
 *
 * The previous split between a "base DTCG" and an "extended DTCG"
 * encoding was retired pre-rc.1 — see
 * `docs/plans/2026-05-23-dtcg-theme-consolidation.md`.
 */

// Theme types
export type {
  DtcgTheme,
  DtcgToken,
  ParsedTheme,
  ThemeEntry,
  ThemeMode,
  ThemeRegistration,
} from './types';

// Theme parser — `parseTheme` for the strict DtcgTheme path,
// `generateCssVariables` / `generateScopedCssVariables` / `themeToCssVarReferences`
// for the duck-typed file-format path (consumed by `loadTheme({ file })`).
export {
  parseTheme,
  generateCssVariables,
  generateScopedCssVariables,
  themeToCssVarReferences,
  generateThemeReferenceDocumentation,
} from './parser';

// Theme validator
export { validateTheme } from './validate';
export type { ValidationResult, ValidationIssue } from './validate';

// Theme registry
export {
  getTheme,
  getRawTheme,
  listThemes,
  getDefaultThemeId,
  getThemeIds,
} from './registry';

// Default themes
export { lightTheme } from './defaults/light';
export { darkTheme } from './defaults/dark';

// Theme provider
export { ThemeProvider, useTheme } from './ThemeProvider';
