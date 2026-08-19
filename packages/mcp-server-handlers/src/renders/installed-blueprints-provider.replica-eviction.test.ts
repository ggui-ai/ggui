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
import type { VectorEntry,
  VectorRowSummary } from '@ggui-ai/mcp-server-core';
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
 * Store whose READS keep serving deleted rows until `settle()` — the
 * delete lands, but both `listByScope` AND `getByKey` return ghosts,
 * modeling an eventually-consistent backend. Both read paths lag on
 * purpose: since ggui#527 the registry's point-read goes through
 * `getByKey` (never the enumeration) on a keyed store, so a lag model
 * that covered only the listing would no longer exercise the stale-hit
 * class this test guards — the read would already be clean.
 */
class LaggingListVectorStore extends InMemoryVectorStore {
  private readonly ghosts = new Map<string, VectorEntry[]>();

  override async deleteVector(scope: string, key: string): Promise<void> {
    const victim = await super.getByKey(scope, key);
    await super.deleteVector(scope, key);
    if (victim) {
      const bucket = this.ghosts.get(scope) ?? [];
      bucket.push(victim);
      this.ghosts.set(scope, bucket);
    }
  }

  override async listByScope(scope: string): Promise<readonly VectorRowSummary[]> {
    const live = await super.listByScope(scope);
    // Enumeration is metadata-only (ggui#540) — project the ghosts the
    // same way the real store projects its rows.
    const ghosts = (this.ghosts.get(scope) ?? [])
      .filter((g) => !live.some((l) => l.key === g.key))
      .map(({ key, metadata }) => ({ key, metadata }));
    return [...live, ...ghosts];
  }

  override async getByKey(scope: string, key: string): Promise<VectorEntry | null> {
    const live = await super.getByKey(scope, key);
    if (live) return live;
    return (this.ghosts.get(scope) ?? []).find((g) => g.key === key) ?? null;
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
