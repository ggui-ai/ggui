/**
 * Operator-class blueprint handler family.
 *
 * Five MCP tools, all `audience: ['ops']`, all served on `/control`:
 *
 *   - `createGguiOpsGenerateBlueprintHandler` —
 *     `ggui_ops_generate_blueprint`. Author a new blueprint variant
 *     by dispatching through the registry's selected generator.
 *   - `createGguiOpsRegisterBlueprintHandler` —
 *     `ggui_ops_register_blueprint`. Register a pre-built blueprint
 *     variant (operator-supplied componentCode bytes, no LLM
 *     dispatch).
 *   - `createGguiOpsListBlueprintsHandler` —
 *     `ggui_ops_list_blueprints`. Enumerate metadata under filters
 *     (indexed list when only `contractHash` is set; semantic search
 *     via `BlueprintSearch` otherwise).
 *   - `createGguiOpsUpdateBlueprintHandler` —
 *     `ggui_ops_update_blueprint`. Patch the mutable surface
 *     (`isOperatorDefault`, `variance`).
 *   - `createGguiOpsDeleteBlueprintHandler` —
 *     `ggui_ops_delete_blueprint`. Idempotent removal.
 *
 * **Deployment boundary (revised 2026-08-14, ggui#501):** this family
 * mounts on any control plane whose deployment supplies the
 * store/search/authorizer deps. Single-operator deployments bind an
 * allow-all authorizer; multi-user deployments supply one that
 * enforces their ownership model.
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
export {
  resolveEffectiveAppId,
  CrossAppCurationUnavailableError,
  AppCurationDeniedError,
  type OpsBlueprintAppAccess,
  type OpsBlueprintAppAuthorizer,
} from './app-access.js';
