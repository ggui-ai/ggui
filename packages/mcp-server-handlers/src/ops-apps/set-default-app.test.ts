import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createSetDefaultAppHandler } from './set-default-app.js';
import { AppNotFoundError } from './rename-app.js';
import {
  InMemoryAppsSource,
  InMemoryUserDefaultAppSource,
} from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createSetDefaultAppHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createSetDefaultAppHandler({
      apps: new InMemoryAppsSource(),
      userDefaultApp: new InMemoryUserDefaultAppSource(),
    });
    expect(handler.name).toBe('ggui_ops_set_default_app');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createSetDefaultAppHandler — happy path', () => {
  it('writes User.defaultAppId when the caller owns the target', async () => {
    const apps = new InMemoryAppsSource();
    const userDefaultApp = new InMemoryUserDefaultAppSource();
    const created = await apps.create({
      ownerSub: 'user-1',
      displayName: 'A',
    });
    const handler = createSetDefaultAppHandler({ apps, userDefaultApp });
    const result = await handler.handler(
      { appId: created.appId },
      makeCtx(),
    );
    expect(result.defaultAppId).toBe(created.appId);
    const stored = await userDefaultApp.getDefault('user-1');
    expect(stored).toBe(created.appId);
  });
});

describe('createSetDefaultAppHandler — tenancy', () => {
  it('rejects cross-user target with AppNotFoundError WITHOUT writing', async () => {
    const apps = new InMemoryAppsSource();
    const userDefaultApp = new InMemoryUserDefaultAppSource();
    const other = await apps.create({
      ownerSub: 'user-2',
      displayName: 'Theirs',
    });
    const handler = createSetDefaultAppHandler({ apps, userDefaultApp });
    await expect(
      handler.handler({ appId: other.appId }, makeCtx({ userId: 'user-1' })),
    ).rejects.toBeInstanceOf(AppNotFoundError);
    const stored = await userDefaultApp.getDefault('user-1');
    expect(stored).toBeNull();
  });
});
