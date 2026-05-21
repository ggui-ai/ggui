/**
 * Gadget export-name grammars — leaf module, ZERO imports.
 *
 * The `use`-prefixed hook grammar and the PascalCase component
 * grammar are needed by both `schemas/data-contract.ts` (wire
 * schemas) and `validation/hygiene-rules.ts` (catalog lints).
 * `data-contract.ts` already imports `KNOWN_PERMISSION_NAMES` from
 * `hygiene-rules.ts`; having `hygiene-rules.ts` import the regexes
 * back from `data-contract.ts` would close an import cycle. Pinning
 * the two grammars in this dependency-free leaf keeps both consumers
 * importing downward only — no cycle is possible.
 *
 * `data-contract.ts` re-exports both symbols, so the package barrel
 * (`index.ts`) surface is unchanged for external consumers.
 */

/**
 * Hook-name grammar — `use`-prefixed camelCase (`useLeafletMap`,
 * `useGeolocation`). Formalizes the convention the boilerplate
 * generator + the LLM rely on. Excludes tab so `gadgetIdentityKey`
 * cannot collide.
 */
export const HOOK_NAME_RE = /^use[A-Z][A-Za-z0-9]*$/;

/**
 * Component-name grammar — PascalCase (`Chart`, `MapView`). A gadget
 * component export is rendered as JSX, so the name must be a legal
 * PascalCase React component identifier.
 */
export const COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;
