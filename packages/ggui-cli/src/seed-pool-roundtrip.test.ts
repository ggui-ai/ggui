import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryVectorStore, InMemoryBlueprintIndex } from '@ggui-ai/mcp-server-core/in-memory';
import {
  registerBlueprint,
  listRegistryBlueprintsForExport,
  buildSeedPool,
  findBlueprintExact,
} from '@ggui-ai/mcp-server-handlers';
import { blueprintKey, variantKey, toPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';
import { PROTOCOL_VERSION } from '@ggui-ai/protocol/version';
import type { DataContract } from '@ggui-ai/protocol';
import { writePoolArtifact } from './pool-artifact.js';
import { FileSystemSeedPoolSource } from './filesystem-seed-pool-source.js';

const embedding = { id: 'inert', dimensions: 1, embed: async (): Promise<number[]> => [0] };

const contract: DataContract = {
  propsSpec: { properties: { title: { schema: { type: 'string' } } } },
};

const CODE = 'export default function Todo(){ return null }';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ggui-roundtrip-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('shared blueprint pool: full export → artifact → seed pool round trip', () => {
  it('a blueprint registered in deployment A is reusable by exact canonical key in deployment B', async () => {
    // ── Deployment A ──────────────────────────────────────────────────────────
    // Register a template blueprint into a cache registry (in-memory stand-in
    // for A's persistent store).
    const registryA = {
      embedding,
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
    };
    await registerBlueprint(registryA, 'builder', {
      kind: 'template',
      contract,
      intent: 'a todo list',
      componentCode: CODE,
      source: { kind: 'user' },
      variance: {},
    });

    // Export A's registry → portable records → directory artifact.
    const rows = await listRegistryBlueprintsForExport(registryA.vectorStore, 'builder');
    expect(rows).toHaveLength(1);
    const records = rows.map((r) => toPortableBlueprint(r));
    await writePoolArtifact(dir, records);

    // ── Deployment B ──────────────────────────────────────────────────────────
    // Build a read-only seed pool from the directory artifact — B has no
    // knowledge of A's registry; it only reads the artifact from disk.
    const pool = await buildSeedPool(new FileSystemSeedPoolSource(dir), { scope: 'shared' });
    // `BlueprintPool.scope` is optional on the interface (omitted = per-app
    // default), but `buildSeedPool` always stamps the fixed pool scope —
    // narrow with a real guard so the query below is typed `string`.
    const poolScope = pool.scope;
    if (poolScope === undefined) {
      throw new Error('buildSeedPool must stamp the fixed pool scope');
    }
    expect(poolScope).toBe('shared');

    // ── Exact-key reuse assertion (Option 1) ──────────────────────────────────
    // Query by the SAME canonical key a fresh deployment would compute from the
    // contract alone — this is the load-bearing cross-deployment reuse claim.
    const reused = await findBlueprintExact(
      { vectorStore: pool.registry.vectorStore, index: pool.registry.index },
      poolScope,
      'template',
      blueprintKey(contract),
      variantKey({}),
    );

    expect(reused).not.toBeNull();
    // The component code must survive registry → export → artifact → seed pool
    // byte-for-byte; any truncation, encoding drift, or key mismatch would fail
    // this assertion.
    expect(reused!.componentCode).toBe(CODE);
    // Provenance survives the full round trip — the exported user-arm
    // source is what deployment B's pool row carries.
    expect(reused!.source).toEqual({ kind: 'user' });
  });

  it('exported records carry generatorProtocolVersion stamped to PROTOCOL_VERSION', async () => {
    const registryA = {
      embedding,
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
    };
    await registerBlueprint(registryA, 'builder', {
      kind: 'template',
      contract,
      intent: 'stamp test',
      componentCode: CODE,
      source: { kind: 'user' },
      variance: {},
    });

    const rows = await listRegistryBlueprintsForExport(registryA.vectorStore, 'builder');
    expect(rows).toHaveLength(1);
    const records = rows.map((r) => toPortableBlueprint(r));

    // Every exported record must carry the protocol-version stamp so
    // importers can gate on generator-era compatibility.
    for (const record of records) {
      expect(record.generatorProtocolVersion).toBe(PROTOCOL_VERSION);
    }
  });
});
