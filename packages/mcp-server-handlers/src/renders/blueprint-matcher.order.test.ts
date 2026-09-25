/**
 * ggui#1370 — the exact-key tier runs BEFORE the installed-blueprints walk
 * settles, and only a hit that the walk can never evict is served early.
 *
 * Pinned here, each against a refuter-found failure of a naive reorder:
 *   - a NON-bridge exact hit resolves while `ensureCached` is still pending
 *     (the walk keeps running in the background, once per scope);
 *   - a BRIDGE-owned hit (`installed: true`) waits for the walk and is
 *     re-read fresh, because the walk's orphan sweep may have evicted it
 *     (the G4 stale-cache guarantee);
 *   - a miss waits for the walk and re-reads, so the first match after an
 *     install is still an exact-key hit;
 *   - the semantic tier never runs before the walk settles (an uninstalled
 *     vector is servable there);
 *   - an exact-key lookup that throws is a MISS that still waits;
 *   - no hit-count write is issued before the walk settles — a bump racing
 *     the sweep's delete re-creates the uninstalled vector;
 *   - a rejected or synchronously throwing provider is swallowed either way.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { matchBlueprint } from './blueprint-matcher.js';
import { listBlueprints, registerBlueprint } from './blueprint-registry.js';
import {
  createInstalledBlueprintsProvider,
  type InstalledBlueprintEntry,
  type InstalledBlueprintsProvider,
} from './installed-blueprints-provider.js';

const SCOPE = 'app-order';

const COUNTER_CONTRACT: DataContract = {
  contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
  actionSpec: { increment: { label: 'Increment' } },
};

function makeDeps() {
  return {
    embedding: new MockEmbeddingProvider(),
    vectorStore: new InMemoryVectorStore(),
    index: new InMemoryBlueprintIndex(),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A provider whose walk settles only when the test says so. */
function pendingProvider(
  deps: ReturnType<typeof makeDeps>,
  walk: Promise<void>,
): InstalledBlueprintsProvider & { ensureCached: ReturnType<typeof vi.fn> } {
  return { ensureCached: vi.fn(() => walk), invalidate: vi.fn(), deps };
}

/** True when `p` has settled by the time the macrotask queue drains once. */
async function hasSettled(p: Promise<unknown>): Promise<boolean> {
  const tick = new Promise<'pending'>((r) => setImmediate(() => r('pending')));
  const outcome = await Promise.race([p.then(() => 'settled', () => 'settled'), tick]);
  return outcome === 'settled';
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
}

function entry(args: { id: string; contract: DataContract; intent: string }): InstalledBlueprintEntry {
  return {
    id: args.id,
    manifestPath: `/installed/${args.id}/manifest.json`,
    contract: args.contract,
    intent: args.intent,
  };
}

const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
afterEach(() => warn.mockClear());

describe('exact-key before the walk settles (ggui#1370)', () => {
  it('serves a non-bridge exact-key hit while ensureCached is still pending, having started the walk', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: COUNTER_CONTRACT,
      intent: 'counter',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
    });
    const walk = deferred();
    const provider = pendingProvider(deps, walk.promise);
    const getId = vi.spyOn(deps.index, 'getId');
    const embed = vi.spyOn(deps.embedding, 'embed');
    const query = vi.spyOn(deps.vectorStore, 'query');

    const match = matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'a counter', contract: COUNTER_CONTRACT },
    );
    expect(await hasSettled(match)).toBe(true);
    const result = await match;
    expect(result.strategy).toBe('exact-key');
    if (result.strategy === 'exact-key') expect(result.blueprint.installed).toBeUndefined();
    expect(provider.ensureCached).toHaveBeenCalledTimes(1);
    expect(getId).toHaveBeenCalledTimes(1);
    expect(embed).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    walk.resolve();
    await flush();
  });

  it('holds a bridge-owned exact-key hit until ensureCached settles, then re-reads it fresh', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: COUNTER_CONTRACT,
      intent: 'counter from marketplace',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
      installed: true,
    });
    const walk = deferred();
    const provider = pendingProvider(deps, walk.promise);
    const getId = vi.spyOn(deps.index, 'getId');
    const getByKey = vi.spyOn(deps.vectorStore, 'getByKey');

    const match = matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'a counter', contract: COUNTER_CONTRACT },
    );
    expect(await hasSettled(match)).toBe(false);
    expect(getId).toHaveBeenCalledTimes(1);
    walk.resolve();
    const result = await match;
    expect(result.strategy).toBe('exact-key');
    if (result.strategy === 'exact-key') expect(result.blueprint.installed).toBe(true);
    expect(getId).toHaveBeenCalledTimes(2);
    // Two fresh lookups, plus the hit bump's own read — issued only after
    // the re-read hit, never before the walk settled.
    expect(getByKey).toHaveBeenCalledTimes(3);
  });

  it('G4: a cold process never serves an uninstalled bridge-owned row — the sweep runs before the re-read and before the semantic tier', async () => {
    const deps = makeDeps();
    // A peer replica installed this row earlier; the install is now gone.
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: COUNTER_CONTRACT,
      intent: 'counter from marketplace',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
      installed: true,
    });
    const events: string[] = [];
    const inner = createInstalledBlueprintsProvider({
      installedBlueprints: () => [],
      compile: async () => ({ kind: 'ok', code: 'x' }),
      deps,
    });
    const provider: InstalledBlueprintsProvider = {
      ensureCached: async (scope, options) => {
        await inner.ensureCached(scope, options);
        events.push('ensured');
      },
      invalidate: (scope) => inner.invalidate(scope),
      deps,
    };
    vi.spyOn(deps.vectorStore, 'query').mockImplementation(async (...args) => {
      events.push('query');
      return InMemoryVectorStore.prototype.query.apply(deps.vectorStore, args);
    });

    const result = await matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'a counter', contract: COUNTER_CONTRACT },
    );
    expect(result.strategy).not.toBe('exact-key');
    expect(await listBlueprints(deps, SCOPE)).toHaveLength(0);
    expect(await deps.index.getId(SCOPE, `template:${blueprintKey(COUNTER_CONTRACT)}:`)).toBeNull();
    expect(events[0]).toBe('ensured');
    expect(events.indexOf('query')).not.toBe(0);
  });

  it('an exact miss waits for the walk and re-reads: the first match after an install is still exact-key', async () => {
    const deps = makeDeps();
    const compileResolves: Array<() => void> = [];
    const compile = vi.fn(
      () =>
        new Promise<{ kind: 'ok'; code: string }>((resolve) => {
          compileResolves.push(() => resolve({ kind: 'ok', code: 'export default () => "installed";' }));
        }),
    );
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [
        entry({ id: 'vendor:counter:1.0.0', contract: COUNTER_CONTRACT, intent: 'counter from marketplace' }),
      ],
      compile,
      deps,
    });
    const getId = vi.spyOn(deps.index, 'getId');
    const match = matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'I want a counter', contract: COUNTER_CONTRACT },
    );
    expect(await hasSettled(match)).toBe(false);
    expect(compile).toHaveBeenCalledTimes(1);
    // The pre-walk exact read already happened (1); the walk's own dedup
    // probe (2) and the post-walk re-read (3) follow once compile resolves.
    expect(getId).toHaveBeenCalledTimes(1);
    compileResolves[0]?.();
    const result = await match;
    expect(result.strategy).toBe('exact-key');
    if (result.strategy === 'exact-key') {
      expect(result.blueprint.installed).toBe(true);
      expect(result.blueprint.componentCode).toBe('export default () => "installed";');
    }
    expect(getId).toHaveBeenCalledTimes(3);
  });

  it('never runs the semantic tier before ensureCached settles (contract-less request)', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: COUNTER_CONTRACT,
      intent: 'counter',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
    });
    const walk = deferred();
    const provider = pendingProvider(deps, walk.promise);
    const embed = vi.spyOn(deps.embedding, 'embed');
    const query = vi.spyOn(deps.vectorStore, 'query');
    const match = matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'a counter please' },
    );
    expect(await hasSettled(match)).toBe(false);
    expect(embed).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    walk.resolve();
    await match;
    expect(query).toHaveBeenCalled();
  });

  it('treats an exact-key lookup that throws as a miss that still waits for the walk and re-reads', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: COUNTER_CONTRACT,
      intent: 'counter',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
    });
    const walk = deferred();
    const provider = pendingProvider(deps, walk.promise);
    const getId = vi.spyOn(deps.index, 'getId').mockRejectedValueOnce(new Error('index hiccup'));
    const query = vi.spyOn(deps.vectorStore, 'query');
    const match = matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'a counter', contract: COUNTER_CONTRACT },
    );
    expect(await hasSettled(match)).toBe(false);
    expect(query).not.toHaveBeenCalled();
    walk.resolve();
    const result = await match;
    expect(result.strategy).toBe('exact-key');
    expect(getId).toHaveBeenCalledTimes(2);
  });

  it('issues no hit-count write for a bridge-owned hit before the walk settles, and exactly one after the re-read', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: COUNTER_CONTRACT,
      intent: 'counter from marketplace',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
      installed: true,
    });
    const putVector = vi.spyOn(deps.vectorStore, 'putVector');
    const walk = deferred();
    const provider = pendingProvider(deps, walk.promise);
    const match = matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'a counter', contract: COUNTER_CONTRACT },
    );
    await flush();
    expect(putVector).not.toHaveBeenCalled();
    walk.resolve();
    await match;
    await flush();
    expect(putVector).toHaveBeenCalledTimes(1);
  });

  it('issues the hit-count write for a non-bridge hit only after the walk settles', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: COUNTER_CONTRACT,
      intent: 'counter',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
    });
    const putVector = vi.spyOn(deps.vectorStore, 'putVector');
    const walk = deferred();
    const provider = pendingProvider(deps, walk.promise);
    const result = await matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'a counter', contract: COUNTER_CONTRACT },
    );
    expect(result.strategy).toBe('exact-key');
    await flush();
    expect(putVector).not.toHaveBeenCalled();
    walk.resolve();
    await flush();
    expect(putVector).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected ensureCached on a non-bridge hit with one warning and no unhandled rejection', async () => {
    const deps = makeDeps();
    await registerBlueprint(deps, SCOPE, {
      kind: 'template',
      contract: COUNTER_CONTRACT,
      intent: 'counter',
      componentCode: 'export default () => null;',
      source: { kind: 'user' },
    });
    const provider: InstalledBlueprintsProvider = {
      ensureCached: () => Promise.reject(new Error('walk failed')),
      invalidate: () => undefined,
      deps,
    };
    const result = await matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'a counter', contract: COUNTER_CONTRACT },
    );
    expect(result.strategy).toBe('exact-key');
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('swallows a synchronously throwing ensureCached like a rejected one', async () => {
    const deps = makeDeps();
    const provider: InstalledBlueprintsProvider = {
      ensureCached: () => {
        throw new Error('sync throw');
      },
      invalidate: () => undefined,
      deps,
    };
    const result = await matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'cold scope', contract: COUNTER_CONTRACT },
    );
    expect(result.strategy).toBe('no-match');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
