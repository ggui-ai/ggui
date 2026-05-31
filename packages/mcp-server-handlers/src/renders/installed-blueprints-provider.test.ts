/**
 * Slice 5.2 (2026-05-18) — `InstalledBlueprintsProvider` tests.
 *
 * Pins behaviour that the matcher integration depends on:
 *   - Idempotency per scope: the second `ensureCached` doesn't re-walk.
 *   - Compile failure is swallowed; other entries still cache.
 *   - matchBlueprint with a wired provider sees the installed
 *     blueprint as a Tier-1 cache hit on the very first match call
 *     for the scope (no synth required).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { matchBlueprint } from './blueprint-matcher.js';
import { findBlueprintExact, listBlueprints } from './blueprint-registry.js';
import {
  createInstalledBlueprintsProvider,
  type InstalledBlueprintEntry,
} from './installed-blueprints-provider.js';

const SCOPE = 'app-lazy';

const COUNTER_CONTRACT: DataContract = {
  contextSpec: {
    count: { schema: { type: 'number' }, default: 0 },
  },
  actionSpec: { increment: { label: 'Increment' } },
};

const TIMER_CONTRACT: DataContract = {
  contextSpec: {
    elapsedMs: { schema: { type: 'number' }, default: 0 },
  },
  actionSpec: { reset: { label: 'Reset' } },
};

function makeDeps(): {
  embedding: MockEmbeddingProvider;
  vectorStore: InMemoryVectorStore;
  index: InMemoryBlueprintIndex;
} {
  return {
    embedding: new MockEmbeddingProvider(),
    vectorStore: new InMemoryVectorStore(),
    index: new InMemoryBlueprintIndex(),
  };
}

function entry(args: {
  id: string;
  contract: DataContract;
  intent: string;
}): InstalledBlueprintEntry {
  return {
    id: args.id,
    manifestPath: `/fake/.ggui/installed-blueprints/${args.id}/ggui.ui.json`,
    contract: args.contract,
    intent: args.intent,
  };
}

describe('createInstalledBlueprintsProvider', () => {
  it('compiles + caches every installed blueprint on first ensureCached', async () => {
    const deps = makeDeps();
    const compile = vi.fn(async () => ({
      kind: 'ok' as const,
      code: 'export default () => null;',
    }));
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [
        entry({ id: 'vendor:counter:1.0.0', contract: COUNTER_CONTRACT, intent: 'counter' }),
        entry({ id: 'vendor:timer:1.0.0', contract: TIMER_CONTRACT, intent: 'timer' }),
      ],
      compile,
      deps,
    });

    await provider.ensureCached(SCOPE);

    expect(compile).toHaveBeenCalledTimes(2);
    const list = await listBlueprints(deps, SCOPE);
    expect(list).toHaveLength(2);
    expect(list.every((bp) => bp.provenance === 'install')).toBe(true);
  });

  it('is idempotent per scope — second ensureCached does not re-compile', async () => {
    const deps = makeDeps();
    const compile = vi.fn(async () => ({
      kind: 'ok' as const,
      code: 'export default () => null;',
    }));
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [
        entry({ id: 'vendor:counter:1.0.0', contract: COUNTER_CONTRACT, intent: 'counter' }),
      ],
      compile,
      deps,
    });

    await provider.ensureCached(SCOPE);
    await provider.ensureCached(SCOPE);
    await provider.ensureCached(SCOPE);

    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('shares a single in-flight walk across concurrent callers', async () => {
    const deps = makeDeps();
    const compileResolves: Array<() => void> = [];
    const compile = vi.fn(
      () =>
        new Promise<{ kind: 'ok'; code: string }>((resolve) => {
          compileResolves.push(() => resolve({ kind: 'ok', code: 'x' }));
        }),
    );
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [
        entry({ id: 'vendor:counter:1.0.0', contract: COUNTER_CONTRACT, intent: 'counter' }),
      ],
      compile,
      deps,
    });

    // Fire three concurrent ensureCached calls before the compile
    // resolves — only one compile invocation should happen total.
    const p1 = provider.ensureCached(SCOPE);
    const p2 = provider.ensureCached(SCOPE);
    const p3 = provider.ensureCached(SCOPE);
    // Allow the walk to start.
    await new Promise((r) => setImmediate(r));
    expect(compile).toHaveBeenCalledTimes(1);
    compileResolves[0]?.();
    await Promise.all([p1, p2, p3]);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('continues caching other entries when one compile fails', async () => {
    const deps = makeDeps();
    const compile = vi.fn(async (entry: InstalledBlueprintEntry) => {
      if (entry.id === 'vendor:broken:1.0.0') {
        return {
          kind: 'failure' as const,
          errors: ['unexpected token at line 3'],
        };
      }
      return { kind: 'ok' as const, code: 'export default () => null;' };
    });
    const issues: Array<{ id: string; kind: string }> = [];
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [
        entry({ id: 'vendor:counter:1.0.0', contract: COUNTER_CONTRACT, intent: 'counter' }),
        entry({ id: 'vendor:broken:1.0.0', contract: TIMER_CONTRACT, intent: 'broken' }),
      ],
      compile,
      deps,
      onIssue: (issue) => issues.push({ id: issue.id, kind: issue.kind }),
    });

    await provider.ensureCached(SCOPE);

    expect(issues).toEqual([{ id: 'vendor:broken:1.0.0', kind: 'compile-failed' }]);
    // The healthy entry still cached.
    const list = await listBlueprints(deps, SCOPE);
    expect(list).toHaveLength(1);
    expect(list[0]?.contractKey).toBe(blueprintKey(COUNTER_CONTRACT));
  });

  // Slice 5 follow-up (2026-05-18, H4): when an installed blueprint
  // fails the current boot's compile, any prior `provenance: 'install'`
  // row at the same contractKey is EVICTED. Without this, persistent
  // vectorStores (sqlite, cloud DDB) keep serving stale componentCode
  // from a previous successful boot even after the operator broke or
  // uninstalled the source.
  describe('stale-row eviction on compile/register failure', () => {
    it('evicts the prior install-provenance row when compile fails', async () => {
      // Seed the cache with a working install (simulates a prior boot
      // whose compile succeeded). Then re-run with a failing compile
      // (simulates broken source on the next boot).
      const deps = makeDeps();
      const { registerBlueprint } = await import('./blueprint-registry.js');
      await registerBlueprint(deps, SCOPE, {
        kind: 'template',
        contract: COUNTER_CONTRACT,
        intent: 'prior-boot installed counter',
        componentCode: 'stale-component-code',
        provenance: 'install',
      });
      expect((await listBlueprints(deps, SCOPE)).length).toBe(1);

      const issues: Array<{ id: string; kind: string }> = [];
      const provider = createInstalledBlueprintsProvider({
        installedBlueprints: () => [
          entry({
            id: 'vendor:counter:1.0.0',
            contract: COUNTER_CONTRACT,
            intent: 'counter',
          }),
        ],
        compile: async () => ({
          kind: 'failure' as const,
          errors: ['syntax error at line 3'],
        }),
        deps,
        onIssue: (issue) => issues.push({ id: issue.id, kind: issue.kind }),
      });
      await provider.ensureCached(SCOPE);

      // Compile-failed issue surfaced first, then the stale-row eviction.
      expect(issues).toEqual([
        { id: 'vendor:counter:1.0.0', kind: 'compile-failed' },
        { id: 'vendor:counter:1.0.0', kind: 'stale-row-evicted' },
      ]);
      // The previously-cached install-provenance row is GONE.
      expect((await listBlueprints(deps, SCOPE))).toEqual([]);
    });

    it('does NOT evict a synth-provenance row at the same contractKey', async () => {
      // Defensive: synth-cached rows at the same canonical key
      // (legitimate cold-gen products from a different lifecycle) MUST
      // survive an install-bridge failure. Eviction only targets
      // rows the bridge originally wrote.
      const deps = makeDeps();
      const { registerBlueprint } = await import('./blueprint-registry.js');
      await registerBlueprint(deps, SCOPE, {
        kind: 'template',
        contract: COUNTER_CONTRACT,
        intent: 'synth-cached counter',
        componentCode: 'synth-component-code',
        provenance: 'synth',
      });

      const provider = createInstalledBlueprintsProvider({
        installedBlueprints: () => [
          entry({
            id: 'vendor:counter:1.0.0',
            contract: COUNTER_CONTRACT,
            intent: 'counter',
          }),
        ],
        compile: async () => ({
          kind: 'missing-entry' as const,
          tried: ['/x/index.tsx'],
        }),
        deps,
      });
      await provider.ensureCached(SCOPE);

      // Synth row survives untouched.
      const list = await listBlueprints(deps, SCOPE);
      expect(list).toHaveLength(1);
      expect(list[0]?.provenance).toBe('synth');
      expect(list[0]?.componentCode).toBe('synth-component-code');
    });

    it('evicts on missing-entry compile result too', async () => {
      const deps = makeDeps();
      const { registerBlueprint } = await import('./blueprint-registry.js');
      await registerBlueprint(deps, SCOPE, {
        kind: 'template',
        contract: COUNTER_CONTRACT,
        intent: 'prior-boot counter',
        componentCode: 'stale-code',
        provenance: 'install',
      });

      const provider = createInstalledBlueprintsProvider({
        installedBlueprints: () => [
          entry({
            id: 'vendor:counter:1.0.0',
            contract: COUNTER_CONTRACT,
            intent: 'counter',
          }),
        ],
        compile: async () => ({
          kind: 'missing-entry' as const,
          tried: ['/x/index.tsx'],
        }),
        deps,
      });
      await provider.ensureCached(SCOPE);
      expect(await listBlueprints(deps, SCOPE)).toEqual([]);
    });
  });

  // Slice 5 follow-up (2026-05-18, L7): per-entry compile timeout.
  // A hung compile callback shouldn't sink the entire walk. Timeout
  // routes through the compile-threw path → stale-row eviction.
  it('times out a compile callback that never resolves', async () => {
    const deps = makeDeps();
    const issues: Array<{ kind: string; message: string }> = [];
    // Compile returns a never-resolving promise → must timeout.
    const compile = vi.fn(() => new Promise<never>(() => undefined));
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [
        entry({ id: 'vendor:slow:1.0.0', contract: COUNTER_CONTRACT, intent: 'slow' }),
      ],
      compile,
      deps,
      onIssue: (issue) => issues.push({ kind: issue.kind, message: issue.message }),
      // 50ms timeout so the test stays fast.
      compileTimeoutMs: 50,
    });

    await provider.ensureCached(SCOPE);
    expect(issues[0]?.kind).toBe('compile-threw');
    expect(issues[0]?.message).toMatch(/timed out after 50ms/);
    expect(await listBlueprints(deps, SCOPE)).toEqual([]);
  });

  it('catches a compile callback that throws', async () => {
    const deps = makeDeps();
    const compile = vi.fn(async () => {
      throw new Error('esbuild native binary missing');
    });
    const issues: Array<{ kind: string; message: string }> = [];
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [
        entry({ id: 'vendor:counter:1.0.0', contract: COUNTER_CONTRACT, intent: 'counter' }),
      ],
      compile,
      deps,
      onIssue: (issue) => issues.push({ kind: issue.kind, message: issue.message }),
    });

    await expect(provider.ensureCached(SCOPE)).resolves.toBeUndefined();
    expect(issues).toEqual([
      { kind: 'compile-threw', message: 'esbuild native binary missing' },
    ]);
  });

  it('handles missing-entry compile result', async () => {
    const deps = makeDeps();
    const compile = vi.fn(async () => ({
      kind: 'missing-entry' as const,
      tried: ['/x/index.tsx', '/x/ggui.ui.tsx'],
    }));
    const issues: Array<{ kind: string; message: string }> = [];
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [
        entry({ id: 'vendor:counter:1.0.0', contract: COUNTER_CONTRACT, intent: 'counter' }),
      ],
      compile,
      deps,
      onIssue: (issue) => issues.push({ kind: issue.kind, message: issue.message }),
    });

    await provider.ensureCached(SCOPE);
    expect(issues[0]?.kind).toBe('compile-failed');
    expect(issues[0]?.message).toContain('entry file missing');
    expect(await listBlueprints(deps, SCOPE)).toEqual([]);
  });

  it('marks scope ensured even on discovery throw, so it does not retry', async () => {
    const deps = makeDeps();
    const installedBlueprints = vi.fn(() => {
      throw new Error('glob failed');
    });
    const issues: Array<{ kind: string }> = [];
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints,
      compile: async () => ({ kind: 'ok', code: 'x' }),
      deps,
      onIssue: (issue) => issues.push({ kind: issue.kind }),
    });

    await provider.ensureCached(SCOPE);
    await provider.ensureCached(SCOPE);
    expect(installedBlueprints).toHaveBeenCalledTimes(1);
    expect(issues).toEqual([{ kind: 'compile-threw' }]);
  });

  describe('orphan eviction on entry-set change (G4 stale-cache fix)', () => {
    it('evicts install-provenance rows when an entry disappears between walks', async () => {
      const deps = makeDeps();
      // Two entries on first walk; one disappears on second.
      const callCount = { current: 0 };
      const provider = createInstalledBlueprintsProvider({
        installedBlueprints: () => {
          callCount.current += 1;
          if (callCount.current === 1) {
            return [
              entry({
                id: 'vendor:counter:1.0.0',
                contract: COUNTER_CONTRACT,
                intent: 'counter',
              }),
              entry({
                id: 'vendor:timer:1.0.0',
                contract: TIMER_CONTRACT,
                intent: 'timer',
              }),
            ];
          }
          // Simulate uninstall — timer is gone.
          return [
            entry({
              id: 'vendor:counter:1.0.0',
              contract: COUNTER_CONTRACT,
              intent: 'counter',
            }),
          ];
        },
        compile: async () => ({ kind: 'ok', code: 'x' }),
        deps,
      });

      await provider.ensureCached(SCOPE);
      let cached = await listBlueprints(deps, SCOPE);
      expect(cached).toHaveLength(2);

      await provider.ensureCached(SCOPE);
      cached = await listBlueprints(deps, SCOPE);
      // The orphan (timer) must be gone; counter must remain.
      expect(cached).toHaveLength(1);
      expect(cached[0]!.contractKey).toBe(
        (await import('@ggui-ai/protocol/blueprint-key')).blueprintKey(
          COUNTER_CONTRACT,
        ),
      );
    });

    it('preserves synth-provenance rows even when no installs remain', async () => {
      const deps = makeDeps();
      // Manually seed a synth-provenance row (cold-gen product the
      // matcher wrote).
      const { registerBlueprint } = await import('./blueprint-registry.js');
      await registerBlueprint(deps, SCOPE, {
        kind: 'template',
        contract: COUNTER_CONTRACT,
        componentCode: 'synth code',
        intent: 'synth-cached counter',
        provenance: 'synth',
      });

      const provider = createInstalledBlueprintsProvider({
        installedBlueprints: () => [],
        compile: async () => ({ kind: 'ok', code: 'x' }),
        deps,
      });
      await provider.ensureCached(SCOPE);

      // Synth row survives — orphan eviction only targets install-
      // provenance rows.
      const cached = await listBlueprints(deps, SCOPE);
      expect(cached).toHaveLength(1);
      expect(cached[0]!.provenance).toBe('synth');
    });

    it('invalidate(scope) forces re-walk on next ensureCached', async () => {
      const deps = makeDeps();
      const installedBlueprints = vi.fn(() => [
        entry({
          id: 'vendor:counter:1.0.0',
          contract: COUNTER_CONTRACT,
          intent: 'counter',
        }),
      ]);
      const provider = createInstalledBlueprintsProvider({
        installedBlueprints,
        compile: async () => ({ kind: 'ok', code: 'x' }),
        deps,
      });

      await provider.ensureCached(SCOPE);
      expect(installedBlueprints).toHaveBeenCalledTimes(1);

      // Identical-signature follow-up still invokes discovery, but
      // skips the compile walk.
      await provider.ensureCached(SCOPE);
      expect(installedBlueprints).toHaveBeenCalledTimes(2);

      // Invalidate forces the next call to walk from scratch
      // (signature comparison is reset).
      provider.invalidate(SCOPE);
      await provider.ensureCached(SCOPE);
      // Discovery called again, AND the walk re-runs (proven by no
      // exception + cache row still present).
      expect(installedBlueprints).toHaveBeenCalledTimes(3);
      const cached = await listBlueprints(deps, SCOPE);
      expect(cached).toHaveLength(1);
    });
  });
});

describe('matchBlueprint + installedBlueprints integration', () => {
  it('Tier-1 exact-key hit on the very first match after install', async () => {
    // End-to-end Slice 5 contract: a marketplace-installed blueprint
    // with contract X becomes a cache hit when the agent sends a
    // matchBlueprint request bearing contract X — no synth required.
    const deps = makeDeps();
    const compile = vi.fn(async () => ({
      kind: 'ok' as const,
      code: 'export default () => "installed-component";',
    }));
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [
        entry({ id: 'vendor:counter:1.0.0', contract: COUNTER_CONTRACT, intent: 'counter from marketplace' }),
      ],
      compile,
      deps,
    });

    const match = await matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'I want a counter', contract: COUNTER_CONTRACT },
    );

    expect(match.strategy).toBe('exact-key');
    if (match.strategy !== 'exact-key') return;
    expect(match.blueprint.provenance).toBe('install');
    expect(match.blueprint.componentCode).toBe(
      'export default () => "installed-component";',
    );
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing provider so the match still runs', async () => {
    // Provider correctness violation: ensureCached throws. The
    // matcher MUST defend against this and fall through to a normal
    // (cold-cache) match flow rather than propagating the error.
    const deps = makeDeps();
    const provider = {
      ensureCached: vi.fn(async () => {
        throw new Error('provider went off the rails');
      }),
      invalidate: vi.fn(),
      deps,
    };

    const match = await matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'cold scope', contract: COUNTER_CONTRACT },
    );

    expect(match.strategy).toBe('no-match');
    expect(provider.ensureCached).toHaveBeenCalledTimes(1);
  });

  it('passes the agent-supplied contractKey to ensureCached for the Tier-1 optimization hook', async () => {
    const deps = makeDeps();
    const provider = {
      ensureCached: vi.fn(async () => undefined),
      invalidate: vi.fn(),
      deps,
    };

    await matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'tier-1 lookup', contract: COUNTER_CONTRACT },
    );

    expect(provider.ensureCached).toHaveBeenCalledWith(SCOPE, {
      contractKey: blueprintKey(COUNTER_CONTRACT),
    });
  });

  it('passes no contractKey when the agent omits a contract (Tier-2 semantic path)', async () => {
    const deps = makeDeps();
    const provider = {
      ensureCached: vi.fn(async () => undefined),
      invalidate: vi.fn(),
      deps,
    };

    await matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'tier-2 semantic' },
    );

    expect(provider.ensureCached).toHaveBeenCalledWith(SCOPE, undefined);
  });

  it('after a Tier-1 install hit, findBlueprintExact returns the same row directly', async () => {
    // Confirm the cache write is durable, not just observable through
    // the matcher pass — operator surfaces (cache/list) see the
    // entry too.
    const deps = makeDeps();
    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [
        entry({ id: 'vendor:counter:1.0.0', contract: COUNTER_CONTRACT, intent: 'counter' }),
      ],
      compile: async () => ({ kind: 'ok', code: 'export default () => null;' }),
      deps,
    });

    await matchBlueprint(
      { registry: deps, installedBlueprints: provider },
      SCOPE,
      { intent: 'go', contract: COUNTER_CONTRACT },
    );

    const direct = await findBlueprintExact(
      { vectorStore: deps.vectorStore },
      SCOPE,
      'template',
      blueprintKey(COUNTER_CONTRACT),
    );
    expect(direct?.provenance).toBe('install');
  });
});
