/**
 * Blueprint handler family.
 *
 * Read handlers:
 *   - `createSearchBlueprintsHandler(deps)` — merged search across the
 *     semantic `VectorStore` and the optional manifest
 *     `BlueprintProvider`. Load-bearing.
 *   - `createListFeaturedBlueprintsHandler(deps)` — factory over
 *     `BlueprintProvider.list`. When a provider is bound, returns
 *     the declared catalog entries; absent provider = empty list.
 *   - `createRenderBlueprintHandler(deps)` — factory over `UiRegistry`.
 *     Resolves a blueprint id to its compiled bundle + returns the
 *     code inline. Callers that boot without a registry omit this
 *     handler entirely (no deprecation shim).
 *
 * Compute handlers (no I/O):
 *   - `createValidateBlueprintHandler()` — sequential gated
 *     validator over user-composed blueprints. Wraps the canonical
 *     `validateBlueprint` from `@ggui-ai/ui-gen`.
 *
 * All seam-pure: no AWS imports, no config loading, no logging
 * side-channel. A hosted server layers its logger + observer fan-out
 * on top when wrapping these into its tool-handler shape (a wider
 * `SharedHandler<ToolContext>` re-export).
 */

export {
  createSearchBlueprintsHandler,
  MIN_SIMILARITY_SCORE,
  MANIFEST_EXACT_NAME_SCORE,
  MANIFEST_SUBSTRING_SCORE,
} from './search-blueprints.js';
export type { SearchBlueprintsDeps } from './search-blueprints.js';
export { createListFeaturedBlueprintsHandler } from './list-featured-blueprints.js';
export type {
  ListFeaturedBlueprintsDeps,
  ListFeaturedBlueprintsOutput,
} from './list-featured-blueprints.js';
export { createRenderBlueprintHandler } from './render-blueprint.js';
export type { RenderBlueprintDeps } from './render-blueprint.js';
export { createValidateBlueprintHandler } from './validate-blueprint.js';
export { createGetBlueprintBoilerplateHandler } from './get-blueprint-boilerplate.js';
export { createListAvailablePrimitivesHandler } from './list-available-primitives.js';
export { createDescribeBlueprintFormatHandler } from './describe-blueprint-format.js';
export { createDescribeDataContractFormatHandler } from './describe-data-contract-format.js';
export { createGetExampleBlueprintsHandler } from './get-example-blueprints.js';
