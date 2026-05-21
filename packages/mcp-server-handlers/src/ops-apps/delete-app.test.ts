import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createDeleteAppHandler } from './delete-app.js';
import { InMemoryAppsSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createDeleteAppHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createDeleteAppHandler({
      apps: new InMemoryAppsSource(),
    });
    expect(handler.name).toBe('ggui_ops_delete_app');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createDeleteAppHandler — happy path', () => {
  it('removes an existing app', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({
      ownerSub: 'user-1',
      displayName: 'A',
    });
    const handler = createDeleteAppHandler({ apps });
    const result = await handler.handler(
      { appId: created.appId },
      makeCtx(),
    );
    expect(result).toEqual({ deleted: true });
    const list = await apps.list('user-1');
    expect(list).toHaveLength(0);
  });
});

describe('createDeleteAppHandler — idempotent', () => {
  it('returns {deleted: true} when the id does not exist', async () => {
    const handler = createDeleteAppHandler({
      apps: new InMemoryAppsSource(),
    });
    const result = await handler.handler({ appId: 'app_nope' }, makeCtx());
    expect(result).toEqual({ deleted: true });
  });
});

describe('createDeleteAppHandler — tenancy', () => {
  it('returns {deleted: true} on cross-user probe WITHOUT touching the row', async () => {
    const apps = new InMemoryAppsSource();
    const other = await apps.create({
      ownerSub: 'user-2',
      displayName: 'Theirs',
    });
    const handler = createDeleteAppHandler({ apps });
    const result = await handler.handler(
      { appId: other.appId },
      makeCtx({ userId: 'user-1' }),
    );
    expect(result).toEqual({ deleted: true });
    // The row MUST still exist under user-2.
    const list = await apps.list('user-2');
    expect(list).toHaveLength(1);
  });
});
