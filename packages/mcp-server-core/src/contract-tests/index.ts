/**
 * Contract tests for the §6.8-6.10 seams.
 *
 * Consume these from adapter-package test suites to prove conformance:
 *
 * ```ts
 * import {
 *   vectorStoreContract,
 *   kvStoreContract,
 *   embeddingProviderContract,
 * } from '@ggui-ai/mcp-server-core/contract-tests';
 * ```
 *
 * Requires `vitest` at test-runtime: every suite in this subpath
 * imports `describe`/`it`/`expect` explicitly from `'vitest'`
 * (declared as an optional peer dependency — install it in your test
 * environment to consume this subpath). The suites are not
 * runner-portable; a Jest project would need vitest installed for the
 * import specifiers to resolve.
 */

export {
  enumerableVectorStoreContract,
  vectorStoreContract,
} from './vector-store.js';
// (scope, exactKey) → blueprint UUID seam. The first-write-wins dedup
// case is the load-bearing assertion. Interface lives in
// `../blueprint-index.ts`.
export { runBlueprintIndexConformance } from './blueprint-index.js';
export type { BlueprintIndexConformanceFactory } from './blueprint-index.js';
export { kvStoreContract } from './kv-store.js';
export type { KvContractClock, KvContractOptions } from './kv-store.js';
export { embeddingProviderContract } from './embedding-provider.js';
export { gguiSessionStoreContract } from './ggui-session-store.js';
export type {
  GguiSessionStoreContractClock,
  GguiSessionStoreContractOptions,
} from './ggui-session-store.js';
export { threadStoreContract } from './thread-store.js';
export { authAdapterContract } from './auth-adapter.js';
export type { AuthAdapterContractOptions } from './auth-adapter.js';
export { pairingServiceContract } from './pairing.js';
export type {
  PairingContractClock,
  PairingContractOptions,
} from './pairing.js';
export { blueprintProviderContract } from './blueprint-provider.js';
export type { BlueprintProviderContractOptions } from './blueprint-provider.js';
export { streamFanoutContract } from './stream-fanout.js';
export { scopedFileStoreContract } from './scoped-file-store.js';

// Bug-class focused conformance suites. Sibling-but-narrower to the
// existing `gguiSessionStoreContract` / `pendingEventConsumerContract` —
// these pin known real bug classes plus the foundational lifecycle
// invariants (event monotonicity, close surface). Plug into adapter
// test suites alongside the basic contract to widen the drift net.
export { runGguiSessionStoreConformance } from './ggui-session-store.conformance.js';
export type { GguiSessionStoreConformanceFactory } from './ggui-session-store.conformance.js';
export { runPendingEventConsumerConformance } from './pending-event-consumer.conformance.js';
export type { PendingEventConsumerConformanceFactory } from './pending-event-consumer.conformance.js';

// Blueprint conformance — store + search seams.
export { runBlueprintStoreConformance } from './blueprint-store.conformance.js';
export type { BlueprintStoreConformanceFactory } from './blueprint-store.conformance.js';
export { runBlueprintSearchConformance } from './blueprint-search.conformance.js';
export type { BlueprintSearchConformanceFactory } from './blueprint-search.conformance.js';
