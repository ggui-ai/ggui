import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { AppNotFoundError, createRenameAppHandler } from './rename-app.js';
import { InMemoryAppsSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createRenameAppHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createRenameAppHandler({
      apps: new InMemoryAppsSource(),
    });
    expect(handler.name).toBe('ggui_ops_rename_app');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createRenameAppHandler — happy path', () => {
  it('updates displayName on the targeted row', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({
      ownerSub: 'user-1',
      displayName: 'Old',
    });
    const handler = createRenameAppHandler({ apps });
    const result = await handler.handler(
      { appId: created.appId, displayName: 'New' },
      makeCtx(),
    );
    expect(result.displayName).toBe('New');
    const stored = await apps.get({
      appId: created.appId,
      ownerSub: 'user-1',
    });
    expect(stored?.displayName).toBe('New');
  });
});

describe('createRenameAppHandler — not found', () => {
  it('throws AppNotFoundError when the id is unknown', async () => {
    const handler = createRenameAppHandler({
      apps: new InMemoryAppsSource(),
    });
    await expect(
      handler.handler(
        { appId: 'app_nope', displayName: 'X' },
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });
});

describe('createRenameAppHandler — tenancy', () => {
  it('rejects cross-user renames with AppNotFoundError', async () => {
    const apps = new InMemoryAppsSource();
    const other = await apps.create({
      ownerSub: 'user-2',
      displayName: 'Theirs',
    });
    const handler = createRenameAppHandler({ apps });
    await expect(
      handler.handler(
        { appId: other.appId, displayName: 'Hacked' },
        makeCtx({ userId: 'user-1' }),
      ),
    ).rejects.toBeInstanceOf(AppNotFoundError);
    // Original row MUST be untouched
    const stillThere = await apps.get({
      appId: other.appId,
      ownerSub: 'user-2',
    });
    expect(stillThere?.displayName).toBe('Theirs');
  });

  it('throws on empty identity', async () => {
    const handler = createRenameAppHandler({
      apps: new InMemoryAppsSource(),
    });
    await expect(
      handler.handler(
        { appId: 'x', displayName: 'y' },
        { appId: '', requestId: 'req-3' },
      ),
    ).rejects.toThrow();
  });
});
