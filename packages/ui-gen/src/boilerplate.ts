// packages/ui-gen/src/boilerplate.ts
//
// Public barrel for `@ggui-ai/ui-gen/boilerplate`.
//
// Surface (barrel-surface rule — minimum viable API):
//   - `generateBoilerplate(userPrompt, contract, shellType, screen, composedSections)`
//     returns the starting `.tsx` boilerplate for the coding agent to fill.
//   - `jsonSchemaTypeToTs(schema)` converts a JsonSchema to a TypeScript
//     type string. Exposed because it's the primitive behind contract →
//     typed Props derivation and is used by callers that assemble their
//     own prompt fragments.
//   - `ShellType` / `ScreenSize` type aliases for the two rendering-context
//     dimensions.
//
// The render infrastructure (renderBoilerplate + BoilerplateMarkers + the
// .tmpl template loader) stays package-private. Template files live under
// `packages/ui-gen/src/boilerplate/templates/` and ship with `src/` in the
// tarball (see package.json `files`).

export { generateBoilerplate } from "./boilerplate/generate.js";
export type { ShellType, ScreenSize } from "./boilerplate/generate.js";
export { jsonSchemaTypeToTs } from "./boilerplate/json-schema-ts.js";
export { buildSystemPrompt } from "./boilerplate/system-prompt.js";
export type { SystemPromptInputs } from "./boilerplate/system-prompt.js";
