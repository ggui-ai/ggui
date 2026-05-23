/**
 * Theme Module Exports
 *
 * Provides the DTCG-based theming system including token parsers, a theme
 * registry with built-in themes, default light/dark themes, and React
 * context providers for runtime theme switching.
 */

// Legacy DTCG Types and Parser (base token system)
export type { BaseDtcgTheme, DTCGToken, DTCGTokenType, ShadowValue } from './dtcg/types';
export {
  generateCssVariables,
  generateScopedCssVariables,
  themeToCssVarReferences,
  generateCssVariableDocumentation,
} from './dtcg/parser';

// Extended DTCG Theme Types (theme selector system)
export type {
  DtcgTheme,
  DtcgToken,
  ParsedTheme,
  ThemeEntry,
  ThemeMode,
  ThemeRegistration,
} from './types';

// Theme Parser (extended)
export { parseTheme } from './parser';

// Theme Validator
export { validateTheme } from './validate';
export type { ValidationResult, ValidationIssue } from './validate';

// Theme Registry
export {
  getTheme,
  getRawTheme,
  listThemes,
  getDefaultThemeId,
  getThemeIds,
} from './registry';

// Default Themes
export { lightTheme } from './defaults/light';
export { darkTheme } from './defaults/dark';

// Theme Provider
export { ThemeProvider, useTheme } from './ThemeProvider';
