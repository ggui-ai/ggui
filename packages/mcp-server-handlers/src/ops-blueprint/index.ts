/**
 * Operator-class blueprint handler family.
 *
 * Four MCP tools, all `audience: ['ops']`, all served on `/ops`:
 *
 *   - `createGguiOpsGenerateBlueprintHandler` —
 *     `ggui_ops_generate_blueprint`. Author a new blueprint variant
 *     by dispatching through the registry's selected generator.
 *   - `createGguiOpsListBlueprintsHandler` —
 *     `ggui_ops_list_blueprints`. Enumerate metadata under filters
 *     (indexed list when only `contractHash` is set; semantic search
 *     via `BlueprintSearch` otherwise).
 *   - `createGguiOpsUpdateBlueprintHandler` —
 *     `ggui_ops_update_blueprint`. Patch the mutable surface
 *     (`isOperatorDefault`, `variance`).
 *   - `createGguiOpsDeleteBlueprintHandler` —
 *     `ggui_ops_delete_blueprint`. Idempotent removal.
 */

export {
  createGguiOpsGenerateBlueprintHandler,
  type GguiOpsGenerateBlueprintDeps,
  type PutCodeHook,
} from './generate.js';
export {
  createGguiOpsRegisterBlueprintHandler,
  type GguiOpsRegisterBlueprintDeps,
} from './register.js';
export {
  createGguiOpsListBlueprintsHandler,
  type GguiOpsListBlueprintsDeps,
} from './list.js';
export {
  createGguiOpsUpdateBlueprintHandler,
  type GguiOpsUpdateBlueprintDeps,
  BlueprintAppMismatchError,
} from './update.js';
export {
  createGguiOpsDeleteBlueprintHandler,
  type GguiOpsDeleteBlueprintDeps,
} from './delete.js';
export {
  GeneratorNotFoundError,
  MissingCredentialsError,
  GenerationFailedError,
} from './errors.js';
export {
  normalizePersona,
  levenshtein,
  findNearDuplicatePersona,
  type NearDuplicatePersonaCheck,
} from './persona-normalization.js';
