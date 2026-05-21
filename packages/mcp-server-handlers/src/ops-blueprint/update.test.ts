import { describe, expect, it } from 'vitest';
import type { Blueprint, DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { InMemoryBlueprintStore } from '@ggui-ai/mcp-server-core/in-memory';
import { BlueprintNotFoundError } from '@ggui-ai/mcp-server-core';
import type { HandlerContext } from '../types.js';
import {
  BlueprintAppMismatchError,
  createGguiOpsUpdateBlueprintHandler,
} from './update.js';

function makeCtx(appId: string): HandlerContext {
  return { appId, requestId: 'req-1' };
}

function emptyContract(): DataContract {
  return {};
}

function makeSeed(opts: {
  blueprintId?: string;
  appId?: string;
  persona?: string;
  isOperatorDefault?: true;
  context?: { [k: string]: string | number };
  seedPrompt?: string;
} = {}): Blueprint {
  const contract = emptyContract();
  return {
    blueprintId: opts.blueprintId ?? 'bp_seed',
    contractHash: blueprintKey(contract),
    appId: opts.appId ?? 'app-1',
    generator: 'ui-gen-default-haiku-4-5',
    codeHash: 'codehash_abc',
    variance: {
      ...(opts.persona !== undefined ? { persona: opts.persona } : {}),
      ...(opts.context !== undefined ? { context: opts.context } : {}),
      ...(opts.seedPrompt !== undefined ? { seedPrompt: opts.seedPrompt } : {}),
    },
    ...(opts.isOperatorDefault === true ? { isOperatorDefault: true } : {}),
    createdAt: '2026-05-12T00:00:00.000Z',
    createdBy: 'operator',
    contract,
  };
}

describe('createGguiOpsUpdateBlueprintHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsUpdateBlueprintHandler({ blueprintStore });
    expect(handler.name).toBe('ggui_ops_update_blueprint');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createGguiOpsUpdateBlueprintHandler — variance patch', () => {
  it('merges partial variance — supplied keys overwrite, omitted preserve', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(
      makeSeed({
        persona: 'minimalist',
        context: { palette: 'cool' },
      }),
    );
    const handler = createGguiOpsUpdateBlueprintHandler({ blueprintStore });
    await handler.handler(
      {
        blueprintId: 'bp_seed',
        variance: { persona: 'data-dense' },
      },
      makeCtx('app-1'),
    );
    const after = await blueprintStore.get('bp_seed');
    expect(after?.variance.persona).toBe('data-dense');
    expect(after?.variance.context).toEqual({ palette: 'cool' });
  });

  it('normalizes persona on patch', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(makeSeed());
    const handler = createGguiOpsUpdateBlueprintHandler({ blueprintStore });
    await handler.handler(
      {
        blueprintId: 'bp_seed',
        variance: { persona: '  Data-Dense  ' },
      },
      makeCtx('app-1'),
    );
    const after = await blueprintStore.get('bp_seed');
    expect(after?.variance.persona).toBe('data-dense');
  });

  it('removes persona when empty string is supplied', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(makeSeed({ persona: 'minimalist' }));
    const handler = createGguiOpsUpdateBlueprintHandler({ blueprintStore });
    await handler.handler(
      {
        blueprintId: 'bp_seed',
        variance: { persona: '' },
      },
      makeCtx('app-1'),
    );
    const after = await blueprintStore.get('bp_seed');
    expect(after?.variance.persona).toBeUndefined();
  });
});

describe('createGguiOpsUpdateBlueprintHandler — operator default', () => {
  it('pins as operator default when isOperatorDefault=true', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(makeSeed());
    const handler = createGguiOpsUpdateBlueprintHandler({ blueprintStore });
    await handler.handler(
      {
        blueprintId: 'bp_seed',
        isOperatorDefault: true,
      },
      makeCtx('app-1'),
    );
    const after = await blueprintStore.get('bp_seed');
    expect(after?.isOperatorDefault).toBe(true);
  });

  it('clears prior default when toggling to a different row in same group', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(
      makeSeed({ blueprintId: 'bp_a', isOperatorDefault: true }),
    );
    await blueprintStore.put(makeSeed({ blueprintId: 'bp_b' }));
    const handler = createGguiOpsUpdateBlueprintHandler({ blueprintStore });
    await handler.handler(
      {
        blueprintId: 'bp_b',
        isOperatorDefault: true,
      },
      makeCtx('app-1'),
    );
    const aRow = await blueprintStore.get('bp_a');
    const bRow = await blueprintStore.get('bp_b');
    expect(aRow?.isOperatorDefault).toBeUndefined();
    expect(bRow?.isOperatorDefault).toBe(true);
  });
});

describe('createGguiOpsUpdateBlueprintHandler — immutable fields', () => {
  it('preserves contractHash + codeHash + generator + createdBy + createdAt', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const seed = makeSeed({
      persona: 'minimalist',
    });
    await blueprintStore.put(seed);
    const handler = createGguiOpsUpdateBlueprintHandler({ blueprintStore });
    await handler.handler(
      {
        blueprintId: 'bp_seed',
        variance: { persona: 'data-dense' },
      },
      makeCtx('app-1'),
    );
    const after = await blueprintStore.get('bp_seed');
    expect(after?.contractHash).toBe(seed.contractHash);
    expect(after?.codeHash).toBe(seed.codeHash);
    expect(after?.generator).toBe(seed.generator);
    expect(after?.createdBy).toBe(seed.createdBy);
    expect(after?.createdAt).toBe(seed.createdAt);
  });
});

describe('createGguiOpsUpdateBlueprintHandler — errors', () => {
  it('throws BlueprintNotFoundError for unknown id', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsUpdateBlueprintHandler({ blueprintStore });
    await expect(
      handler.handler(
        {
          blueprintId: 'bp_missing',
          variance: { persona: 'minimalist' },
        },
        makeCtx('app-1'),
      ),
    ).rejects.toBeInstanceOf(BlueprintNotFoundError);
  });

  it('throws BlueprintAppMismatchError on cross-tenant update', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    await blueprintStore.put(makeSeed({ appId: 'app-1' }));
    const handler = createGguiOpsUpdateBlueprintHandler({ blueprintStore });
    await expect(
      handler.handler(
        {
          blueprintId: 'bp_seed',
          isOperatorDefault: true,
        },
        makeCtx('app-2'),
      ),
    ).rejects.toBeInstanceOf(BlueprintAppMismatchError);
  });

  it('throws on empty appId', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsUpdateBlueprintHandler({ blueprintStore });
    await expect(
      handler.handler(
        { blueprintId: 'bp_seed' },
        { appId: '', requestId: 'req-1' },
      ),
    ).rejects.toThrow();
  });
});
