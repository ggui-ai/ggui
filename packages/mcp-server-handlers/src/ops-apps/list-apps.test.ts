import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createListAppsHandler } from './list-apps.js';
import { InMemoryAppsSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createListAppsHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createListAppsHandler({
      apps: new InMemoryAppsSource(),
    });
    expect(handler.name).toBe('ggui_ops_list_apps');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createListAppsHandler — happy path', () => {
  it('returns only the calling user’s apps', async () => {
    const apps = new InMemoryAppsSource();
    await apps.create({ ownerSub: 'user-1', displayName: 'A' });
    await apps.create({ ownerSub: 'user-1', displayName: 'B' });
    await apps.create({ ownerSub: 'user-2', displayName: 'OtherUserApp' });
    const handler = createListAppsHandler({ apps });
    const result = await handler.handler({}, makeCtx());
    expect(result.apps).toHaveLength(2);
    const names = result.apps.map((a) => a.displayName).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('returns an empty list when the user has no apps', async () => {
    const handler = createListAppsHandler({ apps: new InMemoryAppsSource() });
    const result = await handler.handler({}, makeCtx());
    expect(result.apps).toEqual([]);
  });
});

describe('createListAppsHandler — identity', () => {
  it('falls back to ctx.appId when ctx.userId is unset', async () => {
    const apps = new InMemoryAppsSource();
    await apps.create({ ownerSub: 'oss-user', displayName: 'Only' });
    const handler = createListAppsHandler({ apps });
    const result = await handler.handler(
      {},
      { appId: 'oss-user', requestId: 'req-2' },
    );
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0]?.displayName).toBe('Only');
  });

  it('throws on empty identity', async () => {
    const handler = createListAppsHandler({ apps: new InMemoryAppsSource() });
    await expect(
      handler.handler({}, { appId: '', requestId: 'req-3' }),
    ).rejects.toThrow();
  });
});
