import { describe, expect, it, vi } from 'vitest';
import type { Blueprint, DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  InMemoryBlueprintIndex,
  InMemoryBlueprintStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { HandlerContext } from '../types.js';
import { findBlueprintExact, listBlueprints } from '../renders/blueprint-registry.js';
import { createGguiOpsDeleteBlueprintHandler } from './delete.js';
import { createGguiOpsRegisterBlueprintHandler } from './register.js';

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
      generator: 'ui-gen-default',
      model: 'anthropic/claude-haiku-4-5',
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
  it('returns {deleted: true} without removing rows on cross-app probe', async () => {
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

describe('createGguiOpsDeleteBlueprintHandler — appId input + authorizer', () => {
  it('explicit appId equal to ctx.appId resolves (seam unbound)', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(makeSeed());
    const handler = createGguiOpsDeleteBlueprintHandler({ blueprintStore });
    const result = await handler.handler(
      { blueprintId: 'bp_seed', appId: 'app-1' },
      makeCtx('app-1'),
    );
    expect(result).toEqual({ deleted: true });
    expect(await blueprintStore.get('bp_seed')).toBeNull();
  });

  it('explicit differing appId with NO authorizer fails closed with cross_app_curation_unavailable', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsDeleteBlueprintHandler({ blueprintStore });
    await expect(
      handler.handler({ blueprintId: 'bp_seed', appId: 'other-app' }, makeCtx('app-1')),
    ).rejects.toThrow(/cross_app_curation_unavailable/);
  });

  it('bound authorizer is consulted even when the input is omitted', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const authorizeAppAccess = vi.fn(async () => ({ allowed: true as const }));
    const handler = createGguiOpsDeleteBlueprintHandler({ blueprintStore, authorizeAppAccess });
    await handler.handler({ blueprintId: 'bp_never_existed' }, makeCtx('app-1'));
    expect(authorizeAppAccess).toHaveBeenCalledTimes(1);
  });

  it('authorizer-approved cross-app call deletes a row owned by the EXPLICIT app', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(makeSeed({ appId: 'other-app' }));
    const handler = createGguiOpsDeleteBlueprintHandler({
      blueprintStore,
      authorizeAppAccess: async () => ({ allowed: true as const }),
    });
    const result = await handler.handler(
      { blueprintId: 'bp_seed', appId: 'other-app' },
      makeCtx('app-1'),
    );
    expect(result).toEqual({ deleted: true });
    expect(await blueprintStore.get('bp_seed')).toBeNull();
  });

  it('row-level posture stays uniform {deleted:true} when the effective app does not own the row, even when authorizer-approved', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(makeSeed({ appId: 'third-app' }));
    const handler = createGguiOpsDeleteBlueprintHandler({
      blueprintStore,
      authorizeAppAccess: async () => ({ allowed: true as const }),
    });
    const result = await handler.handler(
      { blueprintId: 'bp_seed', appId: 'other-app' },
      makeCtx('app-1'),
    );
    expect(result).toEqual({ deleted: true });
    // Row-level tenancy holds — the third-app row is untouched even
    // though the authorizer approved the caller's effective appId.
    const stillThere = await blueprintStore.get('bp_seed');
    expect(stillThere).not.toBeNull();
    expect(stillThere?.appId).toBe('third-app');
  });

  it('a foreign appId INPUT denied by the authorizer surfaces the denial error (app-level check precedes row-level uniformity)', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsDeleteBlueprintHandler({
      blueprintStore,
      authorizeAppAccess: async () => ({ allowed: false as const, reason: 'not_owner' as const }),
    });
    await expect(
      handler.handler({ blueprintId: 'bp_never_existed', appId: 'other-app' }, makeCtx('app-1')),
    ).rejects.toThrow(/not curatable/);
  });
});

// ggui#1541 — a delete takes the blueprint out of reuse. Register dual-writes
// (the durable row, and the cache registry the handshake's exact-key probe
// matches from), so delete removes it from BOTH. Before, only the durable row
// went, and the next handshake on the same contract reused the deleted id.
describe('createGguiOpsDeleteBlueprintHandler — the cache registry (ggui#1541)', () => {
  const CONTRACT: DataContract = {
    propsSpec: {
      description: 'delete-test contract',
      properties: { title: { schema: { type: 'string' }, required: false, description: 'optional title' } },
    },
  };
  const CODE = 'export default function Card(){ return null; }';

  async function registered(appId = 'app-1') {
    const blueprintStore = new InMemoryBlueprintStore();
    const cacheRegistry = {
      embedding: new MockEmbeddingProvider(),
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
    };
    const register = createGguiOpsRegisterBlueprintHandler({ blueprintStore, cacheRegistry });
    const { blueprintId } = (await register.handler({ contract: CONTRACT, componentCode: CODE }, makeCtx(appId))) as {
      blueprintId: string;
    };
    const exact = () => findBlueprintExact(cacheRegistry, appId, 'template', blueprintKey(CONTRACT));
    expect(await exact(), 'the registration is reusable before the delete').not.toBeNull();
    return { blueprintStore, cacheRegistry, blueprintId, exact };
  }

  it('register, then delete: the exact-key probe no longer matches, and neither store holds it', async () => {
    const { blueprintStore, cacheRegistry, blueprintId, exact } = await registered();
    const del = createGguiOpsDeleteBlueprintHandler({ blueprintStore, cacheRegistry });
    expect(await del.handler({ blueprintId }, makeCtx('app-1'))).toEqual({ deleted: true });
    expect(await exact()).toBeNull();
    expect(await listBlueprints(cacheRegistry, 'app-1')).toEqual([]);
    expect(await blueprintStore.get(blueprintId)).toBeNull();
  });

  it("re-running a delete clears a cache row an earlier delete left behind (the durable row already gone)", async () => {
    const { blueprintStore, cacheRegistry, blueprintId, exact } = await registered();
    // What a delete did before this fix: the durable row only.
    await blueprintStore.delete(blueprintId);
    expect(await exact(), 'the orphan still matches').not.toBeNull();
    const del = createGguiOpsDeleteBlueprintHandler({ blueprintStore, cacheRegistry });
    expect(await del.handler({ blueprintId }, makeCtx('app-1'))).toEqual({ deleted: true });
    expect(await exact()).toBeNull();
  });

  it('a cross-app probe deletes nothing from either store', async () => {
    const { blueprintStore, cacheRegistry, blueprintId, exact } = await registered('app-1');
    const del = createGguiOpsDeleteBlueprintHandler({ blueprintStore, cacheRegistry });
    expect(await del.handler({ blueprintId }, makeCtx('app-2'))).toEqual({ deleted: true });
    expect(await exact()).not.toBeNull();
    expect(await blueprintStore.get(blueprintId)).not.toBeNull();
  });

  it('a cache delete that fails fails the call and leaves the durable row, so a retry completes it', async () => {
    const { blueprintStore, cacheRegistry, blueprintId, exact } = await registered();
    const failing = vi.spyOn(cacheRegistry.vectorStore, 'deleteVector').mockRejectedValueOnce(new Error('vector store down'));
    const del = createGguiOpsDeleteBlueprintHandler({ blueprintStore, cacheRegistry });
    await expect(del.handler({ blueprintId }, makeCtx('app-1'))).rejects.toThrow('vector store down');
    expect(await blueprintStore.get(blueprintId)).not.toBeNull();
    failing.mockRestore();
    expect(await del.handler({ blueprintId }, makeCtx('app-1'))).toEqual({ deleted: true });
    expect(await exact()).toBeNull();
    expect(await blueprintStore.get(blueprintId)).toBeNull();
  });
});
