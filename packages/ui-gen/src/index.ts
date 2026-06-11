/**
 * `@ggui-ai/ui-gen` — open-source UI generation harness.
 *
 * Implements the `UiGenerator` contract from `@ggui-ai/mcp-server-core`.
 * `createUiGenerator()` returns a callable provider-backed generator:
 *
 *   import { createUiGenerator } from '@ggui-ai/ui-gen';
 *   import { createAnthropicAdapter } from '@ggui-ai/ui-gen/providers';
 *
 *   const generator = createUiGenerator({
 *     adapter: createAnthropicAdapter(),
 *   });
 *   const result = await generator.generate({ request, llm, providerKey, blueprints });
 *
 * The `./harness` / `./workflows` / `./classifier` / `./fragments`
 * subpaths remain available for consumers that want to compose the
 * full triad harness themselves.
 */
export {
  createUiGenerator,
  extractComponentCode,
} from './create-ui-generator.js';
export type { CreateUiGeneratorOptions } from './create-ui-generator.js';

// Generator registry seam re-export. The interface + slug helpers live
// in `@ggui-ai/mcp-server-core`; the in-memory factory lives in
// `@ggui-ai/mcp-server-core/in-memory`. Re-exported here so
// `@ggui-ai/ui-gen` callers can compose a registry alongside
// `createUiGenerator()` in one import.
export {
  createInMemoryGeneratorRegistry,
} from '@ggui-ai/mcp-server-core/in-memory';
export type {
  CreateInMemoryGeneratorRegistryOptions,
} from '@ggui-ai/mcp-server-core/in-memory';

export {
  CompileComponentCodeError,
  compileComponentCode,
  withBrowserCompile,
} from './compile.js';

export {
  buildContractsContext,
  buildRenderingContext,
  buildVarianceContext,
  injectContracts,
  injectRenderingContext,
  injectVariance,
} from './contract-context.js';
export type { RenderingContext } from './contract-context.js';

// ── Anthropic SDK construction ──────────────────────────────────────
//
// Single source of truth for the Anthropic SDK client. Adapters MUST
// go through this helper instead of `new Anthropic(...)` so future
// header / baseURL tweaks land in one place.
export { createAnthropicClient } from './adapters/claude/client.js';
