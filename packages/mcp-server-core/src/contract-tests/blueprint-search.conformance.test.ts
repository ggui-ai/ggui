/**
 * `BlueprintSearch` conformance runner (MVB-2.5, 2026-05-12).
 *
 * Invokes the shared conformance suite against the OSS in-memory
 * implementation. Backend implementations plug their own runner
 * test in beside their adapter.
 */
import { createInMemoryBlueprintSearch } from '../in-memory/blueprint-search.js';
import { InMemoryBlueprintStore } from '../in-memory/blueprint-store.js';
import { runBlueprintSearchConformance } from './blueprint-search.conformance.js';

runBlueprintSearchConformance('InMemoryBlueprintSearch', {
  create: async () => {
    const store = new InMemoryBlueprintStore();
    const search = createInMemoryBlueprintSearch({ blueprintStore: store });
    return { store, search };
  },
});
