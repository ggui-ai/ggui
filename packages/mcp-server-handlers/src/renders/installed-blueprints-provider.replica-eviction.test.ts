/**
 * Replica-local uninstall eviction — regression for the G4
 * pod-matcher stale-cache leak (nightly run 30072993411).
 *
 * Setup mirrors a two-replica deployment: a SHARED enumerable vector
 * store (whose listings LAG deletes, modeling an eventually-consistent
 * enumeration backend) and a PER-REPLICA `BlueprintIndex`. Replica B
 * registers an installed blueprint (walk → Tier-1 binding in B's
 * index). After uninstall, replica A's walk evicts the row via the
 * enumeration-based orphan scan — but the lagging listing keeps
 * serving the deleted row, so B's Tier-1 binding re-validates against
 * the ghost and keeps hitting.
 *
 * The fix under test: each provider instance remembers the bindings
 * it registered and unbinds them by exact key + id on the next walk
 * whose discovery no longer contains them — no enumeration involved,
 * so listing lag cannot resurrect a hit on that instance.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { VectorEntry } from '@ggui-ai/mcp-server-core';
import type { DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  createInstalledBlueprintsProvider,
  type InstalledBlueprintEntry,
} from './installed-blueprints-provider.js';
import { findBlueprintExact } from './blueprint-registry.js';

const CONTRACT: DataContract = {
  contextSpec: {
    status: { schema: { type: 'string' }, default: 'idle' },
  },
  actionSpec: { refresh: { label: 'Refresh' } },
};

const SCOPE = 'app-replica-evict';

const ENTRY: InstalledBlueprintEntry = {
  id: '@e2e/counter:1.0.0',
  manifestPath: 'ddb://app-replica-evict/@e2e/counter@1.0.0',
  contract: CONTRACT,
  intent: 'counter with refresh',
};

/**
 * Enumerable store whose LISTINGS keep serving deleted rows until
 * `settle()` — deletes land in point-state immediately, but
 * `listByScope` returns ghosts, modeling an eventually-consistent
 * enumeration backend.
 */
class LaggingListVectorStore extends InMemoryVectorStore {
  private readonly ghosts = new Map<string, VectorEntry[]>();

  override async deleteVector(scope: string, key: string): Promise<void> {
    const rows = await super.listByScope(scope);
    const victim = rows.find((r) => r.key === key);
    await super.deleteVector(scope, key);
    if (victim) {
      const bucket = this.ghosts.get(scope) ?? [];
      bucket.push(victim);
      this.ghosts.set(scope, bucket);
    }
  }

  override async listByScope(scope: string): Promise<readonly VectorEntry[]> {
    const live = await super.listByScope(scope);
    const ghosts = (this.ghosts.get(scope) ?? []).filter(
      (g) => !live.some((l) => l.key === g.key),
    );
    return [...live, ...ghosts];
  }

  settle(): void {
    this.ghosts.clear();
  }
}

function makeReplica(
  sharedStore: LaggingListVectorStore,
  discovery: () => readonly InstalledBlueprintEntry[],
) {
  const index = new InMemoryBlueprintIndex();
  const deps = {
    embedding: new MockEmbeddingProvider(),
    vectorStore: sharedStore,
    index,
  };
  const provider = createInstalledBlueprintsProvider({
    deps,
    installedBlueprints: () => discovery(),
    compile: async () => ({
      kind: 'ok' as const,
      code: 'export default () => null;',
    }),
  });
  return { provider, deps };
}

describe('replica-local uninstall eviction (G4 stale-cache leak)', () => {
  it('unbinds the registering replica even when the shared listing lags the peer delete', async () => {
    const shared = new LaggingListVectorStore();
    let installedRows: readonly InstalledBlueprintEntry[] = [ENTRY];
    const replicaA = makeReplica(shared, () => installedRows);
    const replicaB = makeReplica(shared, () => installedRows);
    const contractKey = blueprintKey(CONTRACT);

    // B registers via its walk (the priming handshake's replica).
    await replicaB.provider.ensureCached(SCOPE);
    expect(
      await findBlueprintExact(replicaB.deps, SCOPE, 'template', contractKey),
    ).not.toBeNull();

    // Uninstall: the strongly-consistent discovery empties for BOTH
    // replicas at once.
    installedRows = [];

    // A's walk runs first: enumeration-based orphan scan deletes the
    // row from the shared store — but the listing keeps a ghost.
    await replicaA.provider.ensureCached(SCOPE);

    // Pre-walk, B still serves the stale hit through its own binding
    // + the lagging listing: the exact failure mode of the G4
    // pod-matcher spec. (Guards that this test exercises the bug
    // class rather than an already-clean path.)
    expect(
      await findBlueprintExact(replicaB.deps, SCOPE, 'template', contractKey),
    ).not.toBeNull();

    // B's own walk must unbind its local index regardless of the
    // lagging listing.
    await replicaB.provider.invalidate(SCOPE);
    await replicaB.provider.ensureCached(SCOPE);
    expect(
      await findBlueprintExact(replicaB.deps, SCOPE, 'template', contractKey),
    ).toBeNull();

    // And once the listing settles, nothing resurrects.
    shared.settle();
    expect(
      await findBlueprintExact(replicaB.deps, SCOPE, 'template', contractKey),
    ).toBeNull();
  });

  it('signature change alone (no explicit invalidate) also triggers the local unbind', async () => {
    const shared = new LaggingListVectorStore();
    let installedRows: readonly InstalledBlueprintEntry[] = [ENTRY];
    const replicaB = makeReplica(shared, () => installedRows);
    const contractKey = blueprintKey(CONTRACT);

    await replicaB.provider.ensureCached(SCOPE);
    installedRows = [];

    // No peer, no invalidate — just the next handshake's ensureCached
    // seeing a changed (empty) discovery signature.
    await replicaB.provider.ensureCached(SCOPE);
    expect(
      await findBlueprintExact(replicaB.deps, SCOPE, 'template', contractKey),
    ).toBeNull();
  });
});
