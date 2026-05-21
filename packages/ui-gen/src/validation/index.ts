// packages/ui-gen/src/validation/index.ts
//
// Public entrypoint for the `@ggui-ai/ui-gen/validation` subpath.
//
// Two callers:
//   1. ggui's UI generator runtime — runs `validateComponentDetailed` on
//      LLM-produced componentCode as a tier-0 gate.
//   2. ggui's CLI + register endpoint — runs `compileUi` on user-authored
//      TSX components to produce the ESM module the renderer mounts.
//
// `compileUi` and `validateComponentDetailed` share `VALID_PRIMITIVES`
// from `./primitives.ts`, so all three live in the same surface.

export {
  VALID_PRIMITIVES,
  PRIMITIVES_DOCUMENTATION,
  type ValidPrimitive,
} from "./primitives.js";

export {
  validateComponent,
  validateComponentDetailed,
  formatValidationResultForClaude,
  type ValidationError,
  type ValidationErrorType,
  type ValidationOptions,
  type ValidationResult,
  type ValidationWarning,
  type ValidationWarningType,
} from "./component-detailed.js";

export {
  compileUi,
  classifyUiSource,
  contentHash,
  UiBundleSizeError,
  UiValidationError,
  validateUi,
  type CompileOptions,
  type UiCompileResult,
} from "./ui-compiler.js";
