/**
 * `InstalledBlueprintsProvider.drain()` — a server's graceful shutdown awaits the walks still in flight, so a walk
 * that outlives the request that started it (the matcher does not await it on an exact-key hit) is not cut between
 * the vector write and the index write. Without it, a stop signal mid-walk can leave an `installed: true` vector with
 * no index row.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { findBlueprintExact, listBlueprints } from './blueprint-registry.js';
import { createInstalledBlueprintsProvider, type InstalledBlueprintEntry } from './installed-blueprints-provider.js';

const COUNTER: DataContract = {
  contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
  actionSpec: { increment: { label: 'Increment' } },
};

function makeDeps() {
  return { embedding: new MockEmbeddingProvider(), vectorStore: new InMemoryVectorStore(), index: new InMemoryBlueprintIndex() };
}

const entry = (scope: string): InstalledBlueprintEntry => ({
  id: `vendor:counter:${scope}`,
  manifestPath: `/fake/.ggui/installed-blueprints/${scope}/ggui.ui.json`,
  contract: COUNTER,
  intent: 'counter',
});

/** A compile callback that holds until the test releases it. */
function heldCompile() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const compile = async () => {
    calls += 1;
    await gate;
    return { kind: 'ok' as const, code: 'export default () => null;' };
  };
  return { compile, release, calls: () => calls };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe('InstalledBlueprintsProvider.drain', () => {
  it('waits for an in-flight walk to finish its registration: vector row AND index row before drain resolves', async () => {
    const deps = makeDeps();
    const held = heldCompile();
    const provider = createInstalledBlueprintsProvider({ installedBlueprints: () => [entry('a')], compile: held.compile, deps });

    void provider.ensureCached('a'); // fire and forget, as the matcher does on an exact-key hit
    await flush();
    expect(held.calls()).toBe(1);

    let drained = false;
    const drain = provider.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained, 'drain must not resolve while the walk is mid-compile').toBe(false);

    held.release();
    await drain;
    expect(drained).toBe(true);
    const key = blueprintKey(COUNTER);
    const row = await findBlueprintExact(deps, 'a', 'template', key);
    expect(row?.installed, 'the index row exists, so the vector is servable by exact key').toBe(true);
    expect(await listBlueprints(deps, 'a')).toHaveLength(1);
  });

  it('resolves at once when nothing is in flight (idle, and after a settled walk)', async () => {
    const deps = makeDeps();
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [entry('b')],
      compile: async () => ({ kind: 'ok' as const, code: 'export default () => null;' }),
      deps,
    });
    await provider.drain();
    await provider.ensureCached('b');
    let drained = false;
    void provider.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(true);
  });

  it('also waits for a walk that starts while the drain is already waiting', async () => {
    const deps = makeDeps();
    const first = heldCompile();
    const second = heldCompile();
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: (scope) => [entry(scope)],
      compile: (e) => (e.id.endsWith(':c') ? first.compile() : second.compile()),
      deps,
    });
    void provider.ensureCached('c');
    await flush();

    let drained = false;
    const drain = provider.drain().then(() => {
      drained = true;
    });
    await flush();
    void provider.ensureCached('d'); // a second scope's walk, started on the same provider mid-drain
    first.release();
    await flush();
    expect(drained, 'the second walk is still in flight').toBe(false);
    second.release();
    await drain;
    expect(drained).toBe(true);
  });
});

describe('InstalledBlueprintsProvider.drain — walks that leave the per-scope state early', () => {
  it('resolves when a walk throws BEFORE it records its settled state (no spin on a rejected entry)', async () => {
    const deps = makeDeps();
    const bad = {
      ...entry('e'),
      get id(): string {
        throw new Error('broken entry id');
      },
    };
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [bad],
      compile: async () => ({ kind: 'ok' as const, code: 'export default () => null;' }),
      deps,
    });
    await expect(provider.ensureCached('e')).rejects.toThrow('broken entry id');
    let drained = false;
    void provider.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(true);
  });

  it('still waits for a walk whose scope was invalidated while it ran', async () => {
    const deps = makeDeps();
    const held = heldCompile();
    const provider = createInstalledBlueprintsProvider({ installedBlueprints: () => [entry('f')], compile: held.compile, deps });
    void provider.ensureCached('f');
    await flush();
    provider.invalidate('f');
    let drained = false;
    const drain = provider.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained, 'the invalidated walk is still writing').toBe(false);
    held.release();
    await drain;
    expect(drained).toBe(true);
  });
});
