import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createCreateAppHandler } from './create-app.js';
import { InMemoryAppsSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createCreateAppHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createCreateAppHandler({
      apps: new InMemoryAppsSource(),
    });
    expect(handler.name).toBe('ggui_ops_create_app');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createCreateAppHandler — happy path', () => {
  it('mints a fresh app scoped to the caller', async () => {
    const apps = new InMemoryAppsSource();
    const handler = createCreateAppHandler({ apps });
    const result = await handler.handler(
      { displayName: 'Test App' },
      makeCtx(),
    );
    expect(result.displayName).toBe('Test App');
    expect(result.appId).toMatch(/^app_/);
    const list = await apps.list('user-1');
    expect(list).toHaveLength(1);
    expect(list[0]?.ownerSub).toBe('user-1');
  });

  it("defaults displayName to 'My ggui app' when absent", async () => {
    const handler = createCreateAppHandler({
      apps: new InMemoryAppsSource(),
    });
    const result = await handler.handler({}, makeCtx());
    expect(result.displayName).toBe('My ggui app');
  });
});

describe('createCreateAppHandler — identity', () => {
  it('throws on empty identity', async () => {
    const handler = createCreateAppHandler({
      apps: new InMemoryAppsSource(),
    });
    await expect(
      handler.handler({}, { appId: '', requestId: 'req-3' }),
    ).rejects.toThrow();
  });

  it('NEVER allows an argument-supplied ownerSub override (sub-takeover guard)', async () => {
    const apps = new InMemoryAppsSource();
    const handler = createCreateAppHandler({ apps });
    // The schema doesn't accept `ownerSub` — even when present in raw
    // input it gets discarded by the zod parse. The ctx is the only
    // identity source.
    await handler.handler(
      { displayName: 'Evil', ownerSub: 'someone-else' },
      makeCtx({ userId: 'user-1' }),
    );
    const mine = await apps.list('user-1');
    const theirs = await apps.list('someone-else');
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});
