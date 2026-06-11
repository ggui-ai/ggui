import { describe, expect, it } from 'vitest';
import type { Blueprint, DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { InMemoryBlueprintStore } from '@ggui-ai/mcp-server-core/in-memory';
import type { HandlerContext } from '../types.js';
import { createGguiOpsDeleteBlueprintHandler } from './delete.js';

function makeCtx(appId: string): HandlerContext {
  return { appId, requestId: 'req-1' };
}

function emptyContract(): DataContract {
  return {};
}

function makeSeed(opts: { blueprintId?: string; appId?: string } = {}): Blueprint {
  const contract = emptyContract();
  return {
    blueprintId: opts.blueprintId ?? 'bp_seed',
    contractHash: blueprintKey(contract),
    appId: opts.appId ?? 'app-1',
    source: {
      kind: 'llm',
      generator: 'ui-gen-default-haiku-4-5',
      model: 'claude-haiku-4-5',
    },
    variance: {},
    createdAt: '2026-05-12T00:00:00.000Z',
    createdBy: 'operator',
    contract,
  };
}

describe('createGguiOpsDeleteBlueprintHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsDeleteBlueprintHandler({ blueprintStore });
    expect(handler.name).toBe('ggui_ops_delete_blueprint');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createGguiOpsDeleteBlueprintHandler — happy path', () => {
  it('removes an existing blueprint', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(makeSeed());
    const handler = createGguiOpsDeleteBlueprintHandler({ blueprintStore });
    const result = await handler.handler(
      { blueprintId: 'bp_seed' },
      makeCtx('app-1'),
    );
    expect(result).toEqual({ deleted: true });
    const after = await blueprintStore.get('bp_seed');
    expect(after).toBeNull();
  });
});

describe('createGguiOpsDeleteBlueprintHandler — idempotent', () => {
  it('returns {deleted: true} when the id does not exist', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsDeleteBlueprintHandler({ blueprintStore });
    const result = await handler.handler(
      { blueprintId: 'bp_never_existed' },
      makeCtx('app-1'),
    );
    expect(result).toEqual({ deleted: true });
  });

  it('returns {deleted: true} on second delete of the same id', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(makeSeed());
    const handler = createGguiOpsDeleteBlueprintHandler({ blueprintStore });
    await handler.handler({ blueprintId: 'bp_seed' }, makeCtx('app-1'));
    const second = await handler.handler(
      { blueprintId: 'bp_seed' },
      makeCtx('app-1'),
    );
    expect(second).toEqual({ deleted: true });
  });
});

describe('createGguiOpsDeleteBlueprintHandler — tenancy', () => {
  it('returns {deleted: true} without removing rows on cross-tenant probe', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(makeSeed({ appId: 'app-1' }));
    const handler = createGguiOpsDeleteBlueprintHandler({ blueprintStore });
    const result = await handler.handler(
      { blueprintId: 'bp_seed' },
      makeCtx('app-2'),
    );
    expect(result).toEqual({ deleted: true });
    // The row MUST still exist under app-1
    const stillThere = await blueprintStore.get('bp_seed');
    expect(stillThere).not.toBeNull();
    expect(stillThere?.appId).toBe('app-1');
  });

  it('throws on empty appId', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsDeleteBlueprintHandler({ blueprintStore });
    await expect(
      handler.handler(
        { blueprintId: 'bp_seed' },
        { appId: '', requestId: 'req-1' },
      ),
    ).rejects.toThrow();
  });
});
