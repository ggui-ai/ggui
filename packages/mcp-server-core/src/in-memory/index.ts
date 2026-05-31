/**
 * Reference in-memory implementations. Test + dev use only.
 *
 * Production bindings live in separate packages (or, for the hosted
 * runtime's AWS bindings, in `cloud/`). Any production adapter MUST pass the
 * corresponding `*Contract` suite from `@ggui-ai/mcp-server-core/contract-tests`.
 */

export { InMemoryVectorStore } from './vector-store.js';
// (scope, exactKey) → blueprint UUID. First-write-wins `putId` is the
// dedup primitive. Interface lives in `../blueprint-index.ts`.
export { InMemoryBlueprintIndex } from './blueprint-index.js';
export { InMemoryKeyValueStore } from './kv-store.js';
export { MockEmbeddingProvider } from './embedding-provider.js';
export type { MockEmbeddingProviderOptions } from './embedding-provider.js';
export { InMemoryRenderStore } from './render-store.js';
export type { InMemoryRenderStoreOptions } from './render-store.js';
export { InMemoryPendingEventConsumer } from './pending-event-consumer.js';
export { InMemoryActiveConsumerRegistry } from './active-consumer-registry.js';
export { InMemoryThreadStore } from './thread-store.js';
export type { InMemoryThreadStoreOptions } from './thread-store.js';
export { InMemorySessionStreamBuffer } from './session-stream-buffer.js';
export { InProcessStreamFanout } from './stream-fanout.js';
export { InMemoryAuthAdapter } from './auth-adapter.js';
export type { InMemoryAuthAdapterOptions } from './auth-adapter.js';
export { InMemoryPairingService } from './pairing.js';
export type { InMemoryPairingServiceOptions } from './pairing.js';
export { InMemoryBlueprintProvider } from './blueprint-provider.js';
export type {
  BlueprintSeed,
  InMemoryBlueprintProviderOptions,
} from './blueprint-provider.js';
export { ManifestBlueprintProvider } from './manifest-blueprint-provider.js';
export type {
  ManifestBlueprintSeed,
  ManifestBlueprintProviderOptions,
} from './manifest-blueprint-provider.js';
export { InMemoryConnectorRegistry } from './connector-registry.js';
export { InMemoryProviderKeyStore } from './provider-key-store.js';
export { InMemoryApiKeyProvider } from './api-key-provider.js';
export type { InMemoryApiKeyProviderOptions } from './api-key-provider.js';

// Cross-cutting sink reference adapters.
export { NoopTelemetrySink, InMemoryTelemetrySink } from './telemetry-sink.js';
export type { InMemoryTelemetrySinkOptions } from './telemetry-sink.js';
export { NoopAuditSink, InMemoryAuditSink } from './audit-sink.js';

// Admission + accounting reference adapters.
export { InMemoryQuotaStore, windowStartAt } from './quota-store.js';
export type { InMemoryQuotaStoreOptions } from './quota-store.js';
export { NoopRateLimiter, FixedWindowRateLimiter } from './rate-limiter.js';
export type { FixedWindowRateLimiterOptions } from './rate-limiter.js';

// shortCode → session lookup.
export { InMemoryShortCodeIndex } from './short-code-index.js';

// Scoped blob storage seam reference.
export {
  InMemoryScopedFileStore,
  InMemoryScopedFileStoreRegistry,
} from './scoped-file-store.js';

// Content-addressable code delivery — in-memory variant.
export { InMemoryCodeStore } from './code-store.js';

// Per-app metadata reference adapter. Seeds every registered app
// with `STDLIB_GADGETS`. See `app-metadata-store.ts` for the parent
// interface.
export { InMemoryAppMetadataStore } from './app-metadata-store.js';
export type { InMemoryAppRegisterInput } from './app-metadata-store.js';

// Slug-addressable generator registry. The blueprint matcher,
// benchmarks, console, and `ggui_ops_generate_blueprint` all dispatch
// through it. Interface lives in `../generator-registry.ts`.
export { createInMemoryGeneratorRegistry } from './generator-registry.js';
export type { CreateInMemoryGeneratorRegistryOptions } from './generator-registry.js';

// In-memory `BlueprintStore`. Holds the code body inline via
// `Map<codeHash, string>` (the cloud adapter offloads to S3).
// Interface + selector live in `../blueprint-store.ts` +
// `../blueprint-selector.ts`.
export { InMemoryBlueprintStore } from './blueprint-store.js';
export type { InMemoryBlueprintStoreOptions } from './blueprint-store.js';

// In-memory `BlueprintSearch`. Linear scan + scoring helpers against
// an `AppListableBlueprintStore`. Interface + scoring primitives live
// in `../blueprint-search.ts`.
export {
  createInMemoryBlueprintSearch,
  scoreBlueprint,
  stringifyContractForEmbedding,
} from './blueprint-search.js';
export type {
  AppListableBlueprintStore,
  InMemoryBlueprintSearchOptions,
} from './blueprint-search.js';

// In-memory variant-selection cache. Pairs with `selectVariantWithLlm`
// from `../variant-selector-with-llm.ts`. Lazy-expiry TTL (no timers).
// Production deployments bind a Redis-backed adapter against the same
// interface.
export { InMemoryVariantSelectionCache } from './variant-selection-cache.js';
export type { InMemoryVariantSelectionCacheOptions } from './variant-selection-cache.js';
