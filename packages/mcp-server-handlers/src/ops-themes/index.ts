/**
 * ops-themes — runtime theme registration tools (ggui#598-C).
 * Subpath entry, mirroring the other ops families.
 */
export {
  createRegisterThemeHandler,
  type RegisterThemeDeps,
  type RegisterThemeOutput,
  type ThemeCoverageResultLike,
} from './register-theme.js';
export {
  createListThemesHandler,
  type ListThemesDeps,
  type ListThemesOutput,
} from './list-themes.js';
export {
  createDeleteThemeHandler,
  type DeleteThemeDeps,
  type DeleteThemeOutput,
} from './delete-theme.js';
export {
  ThemeCoverageError,
  ThemeDocumentError,
  ThemeIdentityError,
  ThemeQuotaError,
  mapStorePutError,
  type ThemeCoverageValidator,
} from './types.js';
