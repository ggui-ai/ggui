/**
 * Per-user-within-app render isolation (Federation B1, Task 6).
 *
 * Tenancy is `appId`; WITHIN an app, a render stamped with a `userId`
 * is visible only to that same userId. Rows without a `userId` (legacy /
 * non-federated single-user) stay visible to a ctx without a `userId`
 * (back-compat). The gate is shared via `isVisibleToCaller` and wired
 * into both `consume` and `get-session` (+ the `render` reuse gate).
 *
 * The store is seeded via `commit({ render, appId, userId })` — exactly
 * the shape the `ggui_render` handler writes after the Task-6 change to
 * stamp `ctx.userId` on every commit — and the real
 * `createGguiGetSessionHandler` is exercised through its tenancy gate.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiGetSessionHandler } from './get-session.js';
import { GguiSessionNotFoundError } from './errors.js';
import type { HandlerContext } from '../types.js';

const NOW_MS = Date.parse('2026-06-14T00:00:00.000Z');

function ctx(appId: string, userId?: string): HandlerContext {
  return {
    appId,
    requestId: 'r1',
    ...(userId !== undefined ? { userId } : {}),
  };
}

/**
 * Seed a render via `commit` — mirrors the `ggui_render` write path,
 * which now stamps `ctx.userId` on every commit. A `userId` of
 * `undefined` reproduces a legacy / single-user row.
 */
async function seedRender(
  store: InMemoryGguiSessionStore,
  opts: { sessionId?: string; appId?: string; userId?: string } = {},
): Promise<{ sessionId: string }> {
  const sessionId = opts.sessionId ?? 'render-1';
  const appId = opts.appId ?? 'app1';
  const render: ComponentGguiSession = {
    id: sessionId,
    appId,
    type: 'component',
    componentCode: 'export default () => null;',
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
  };
  await store.commit({
    render,
    appId,
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
  });
  return { sessionId };
}

describe('per-user-within-app isolation', () => {
  let store: InMemoryGguiSessionStore;

  beforeEach(() => {
    store = new InMemoryGguiSessionStore();
  });

  it('user B cannot get user A’s render in the same app', async () => {
    const { sessionId } = await seedRender(store, {
      appId: 'app1',
      userId: 'guuey:userA',
    });
    const get = createGguiGetSessionHandler({ renderStore: store });
    await expect(
      get.handler({ sessionId }, ctx('app1', 'guuey:userB')),
    ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
  });

  it('the owner can read their own render', async () => {
    const { sessionId } = await seedRender(store, {
      appId: 'app1',
      userId: 'guuey:userA',
    });
    const get = createGguiGetSessionHandler({ renderStore: store });
    const out = await get.handler({ sessionId }, ctx('app1', 'guuey:userA'));
    expect(out).toBeDefined();
    expect(out.id).toBe(sessionId);
  });

  it('userId-less ctx still reads userId-less rows (back-compat)', async () => {
    const { sessionId } = await seedRender(store, { appId: 'app1' });
    const get = createGguiGetSessionHandler({ renderStore: store });
    const out = await get.handler({ sessionId }, ctx('app1'));
    expect(out).toBeDefined();
    expect(out.id).toBe(sessionId);
  });

  it('cross-app access stays denied regardless of userId', async () => {
    const { sessionId } = await seedRender(store, {
      appId: 'app1',
      userId: 'guuey:userA',
    });
    const get = createGguiGetSessionHandler({ renderStore: store });
    await expect(
      get.handler({ sessionId }, ctx('app-OTHER', 'guuey:userA')),
    ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
  });
});
