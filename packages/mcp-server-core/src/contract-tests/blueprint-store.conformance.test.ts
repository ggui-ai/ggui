/**
 * `BlueprintStore` conformance runner (MVB-2, 2026-05-12).
 *
 * Invokes the shared conformance suite against the OSS in-memory
 * implementation. Cloud adapters (`DynamoBlueprintStore`) plug their
 * own runner test in from `cloud/ggui-protocol-pod/src/adapters/`.
 */
import { InMemoryBlueprintStore } from '../in-memory/blueprint-store.js';
import { runBlueprintStoreConformance } from './blueprint-store.conformance.js';

runBlueprintStoreConformance('InMemoryBlueprintStore', {
  create: async () => new InMemoryBlueprintStore(),
});
