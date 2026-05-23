/**
 * Pure DTCG surface — the React-free subset of `@ggui-ai/design/themes`.
 *
 * Consumed by Node-only tooling that needs to walk DTCG tokens +
 * emit CSS variables without dragging the React runtime through its
 * type graph. Current consumer: `@ggui-ai/project-config/node`'s
 * `loadTheme`, which pre-renders `cssVariables` on the `LoadedTheme`
 * returned from disk.
 *
 * This module re-exports:
 *   - The plain `BaseDtcgTheme` / `DTCGToken` / `ShadowValue` types.
 *   - The pure emitter functions (`generateCssVariables`,
 *     `themeToCssVarReferences`, `generateCssVariableDocumentation`).
 *   - The built-in `lightTheme` + `darkTheme` defaults.
 *
 * Everything here is a value of pure data / pure function — no
 * React, no DOM, no side effects at module load.
 */

export type {
  BaseDtcgTheme,
  DTCGToken,
  DTCGTokenType,
  DTCGTokenGroup,
  ShadowValue,
  TransitionValue,
} from './types';

export {
  generateCssVariables,
  generateScopedCssVariables,
  themeToCssVarReferences,
  generateCssVariableDocumentation,
} from './parser';

export { lightTheme } from '../defaults/light';
export { darkTheme } from '../defaults/dark';
