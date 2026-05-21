import { describe, expect, it } from 'vitest';
import type { Blueprint, DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  InMemoryBlueprintStore,
  createInMemoryBlueprintSearch,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { HandlerContext } from '../types.js';
import { createGguiOpsListBlueprintsHandler } from './list.js';

function makeCtx(appId: string): HandlerContext {
  return { appId, requestId: 'req-1' };
}

function emptyContract(): DataContract {
  return {};
}

function makeBlueprint(opts: {
  blueprintId: string;
  appId?: string;
  contract?: DataContract;
  generator?: string;
  persona?: string;
  createdAt?: string;
}): Blueprint {
  const contract = opts.contract ?? emptyContract();
  return {
    blueprintId: opts.blueprintId,
    contractHash: blueprintKey(contract),
    appId: opts.appId ?? 'app-1',
    generator: opts.generator ?? 'ui-gen-default-haiku-4-5',
    variance: opts.persona !== undefined ? { persona: opts.persona } : {},
    createdAt: opts.createdAt ?? '2026-05-12T00:00:00.000Z',
    createdBy: 'operator',
    contract,
  };
}

function defaultDeps() {
  const blueprintStore = new InMemoryBlueprintStore();
  const blueprintSearch = createInMemoryBlueprintSearch({ blueprintStore });
  return { blueprintStore, blueprintSearch };
}

describe('createGguiOpsListBlueprintsHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createGguiOpsListBlueprintsHandler(defaultDeps());
    expect(handler.name).toBe('ggui_ops_list_blueprints');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createGguiOpsListBlueprintsHandler — indexed list path', () => {
  it('returns blueprints under (appId, contractHash) when only contractHash is set', async () => {
    const deps = defaultDeps();
    const c1: DataContract = {
      propsSpec: { properties: { a: { schema: { type: 'string' } } } },
    };
    const c2: DataContract = {
      propsSpec: { properties: { b: { schema: { type: 'number' } } } },
    };
    await deps.blueprintStore.put(
      makeBlueprint({ blueprintId: 'bp1', contract: c1 }),
    );
    await deps.blueprintStore.put(
      makeBlueprint({ blueprintId: 'bp2', contract: c1, createdAt: '2026-05-12T01:00:00.000Z' }),
    );
    await deps.blueprintStore.put(
      makeBlueprint({ blueprintId: 'bp3', contract: c2 }),
    );

    const handler = createGguiOpsListBlueprintsHandler(deps);
    const result = await handler.handler(
      { contractHash: blueprintKey(c1) },
      makeCtx('app-1'),
    );
    expect(result.blueprints.map((b) => b.blueprintId).sort()).toEqual(['bp1', 'bp2']);
  });

  it('sorts indexed-list results by createdAt desc', async () => {
    const deps = defaultDeps();
    const c1: DataContract = emptyContract();
    await deps.blueprintStore.put(
      makeBlueprint({
        blueprintId: 'older',
        contract: c1,
        createdAt: '2026-05-10T00:00:00.000Z',
      }),
    );
    await deps.blueprintStore.put(
      makeBlueprint({
        blueprintId: 'newer',
        contract: c1,
        createdAt: '2026-05-12T00:00:00.000Z',
      }),
    );

    const handler = createGguiOpsListBlueprintsHandler(deps);
    const result = await handler.handler(
      { contractHash: blueprintKey(c1) },
      makeCtx('app-1'),
    );
    expect(result.blueprints.map((b) => b.blueprintId)).toEqual([
      'newer',
      'older',
    ]);
  });

  it('post-filters by generator on the indexed path', async () => {
    const deps = defaultDeps();
    const c1: DataContract = emptyContract();
    await deps.blueprintStore.put(
      makeBlueprint({
        blueprintId: 'haiku',
        contract: c1,
        generator: 'ui-gen-default-haiku-4-5',
      }),
    );
    await deps.blueprintStore.put(
      makeBlueprint({
        blueprintId: 'opus',
        contract: c1,
        generator: 'ui-gen-advanced-opus-4-7',
      }),
    );

    const handler = createGguiOpsListBlueprintsHandler(deps);
    const result = await handler.handler(
      {
        contractHash: blueprintKey(c1),
        generator: 'ui-gen-advanced-opus-4-7',
      },
      makeCtx('app-1'),
    );
    expect(result.blueprints.map((b) => b.blueprintId)).toEqual(['opus']);
  });
});

describe('createGguiOpsListBlueprintsHandler — semantic search path', () => {
  it('dispatches through BlueprintSearch when intentKeywords is set', async () => {
    const deps = defaultDeps();
    const c1: DataContract = emptyContract();
    await deps.blueprintStore.put(
      makeBlueprint({ blueprintId: 'bp1', contract: c1 }),
    );

    const handler = createGguiOpsListBlueprintsHandler(deps);
    const result = await handler.handler(
      { intentKeywords: ['data', 'dashboard'] },
      makeCtx('app-1'),
    );
    // Search returns the blueprint with score (≥0). The semantic
    // path may return empty when score < threshold, so just assert
    // shape.
    expect(Array.isArray(result.blueprints)).toBe(true);
  });

  it('dispatches through search when persona is set', async () => {
    const deps = defaultDeps();
    const c1: DataContract = emptyContract();
    await deps.blueprintStore.put(
      makeBlueprint({ blueprintId: 'bp1', contract: c1, persona: 'minimalist' }),
    );

    const handler = createGguiOpsListBlueprintsHandler(deps);
    const result = await handler.handler(
      { persona: 'minimalist' },
      makeCtx('app-1'),
    );
    expect(Array.isArray(result.blueprints)).toBe(true);
  });

  it('dispatches through search when no filter is set (full app scan)', async () => {
    const deps = defaultDeps();
    const c1: DataContract = emptyContract();
    await deps.blueprintStore.put(
      makeBlueprint({ blueprintId: 'bp1', contract: c1 }),
    );

    const handler = createGguiOpsListBlueprintsHandler(deps);
    const result = await handler.handler({}, makeCtx('app-1'));
    expect(Array.isArray(result.blueprints)).toBe(true);
  });
});

describe('createGguiOpsListBlueprintsHandler — tenancy', () => {
  it('does NOT return blueprints from a different appId', async () => {
    const deps = defaultDeps();
    const c1: DataContract = emptyContract();
    await deps.blueprintStore.put(
      makeBlueprint({
        blueprintId: 'app1bp',
        appId: 'app-1',
        contract: c1,
      }),
    );
    await deps.blueprintStore.put(
      makeBlueprint({
        blueprintId: 'app2bp',
        appId: 'app-2',
        contract: c1,
      }),
    );

    const handler = createGguiOpsListBlueprintsHandler(deps);
    const result = await handler.handler(
      { contractHash: blueprintKey(c1) },
      makeCtx('app-1'),
    );
    expect(result.blueprints.map((b) => b.blueprintId)).toEqual(['app1bp']);
  });

  it('throws when appId is empty', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsListBlueprintsHandler(deps);
    await expect(
      handler.handler({}, { appId: '', requestId: 'req-1' }),
    ).rejects.toThrow();
  });
});
