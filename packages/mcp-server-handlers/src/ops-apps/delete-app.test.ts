import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createDeleteAppHandler } from './delete-app.js';
import {
  InMemoryAppsSource,
  InMemoryUserDefaultAppSource,
} from './in-memory-fake.test-util.js';
import { DefaultAppDeleteBlockedError } from './types.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

function makeHandler(
  apps = new InMemoryAppsSource(),
  userDefaultApp = new InMemoryUserDefaultAppSource(),
) {
  return {
    apps,
    userDefaultApp,
    handler: createDeleteAppHandler({ apps, userDefaultApp }),
  };
}

describe('createDeleteAppHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const { handler } = makeHandler();
    expect(handler.name).toBe('ggui_ops_delete_app');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createDeleteAppHandler — happy path', () => {
  it('removes an existing app', async () => {
    const { apps, handler } = makeHandler();
    const created = await apps.create({
      ownerSub: 'user-1',
      displayName: 'A',
    });
    const result = await handler.handler({ appId: created.appId }, makeCtx());
    expect(result).toEqual({ deleted: true });
    const list = await apps.list('user-1');
    expect(list).toHaveLength(0);
  });

  it('removes a non-default app while a DIFFERENT default is set', async () => {
    const { apps, userDefaultApp, handler } = makeHandler();
    const keep = await apps.create({ ownerSub: 'user-1', displayName: 'Keep' });
    const drop = await apps.create({ ownerSub: 'user-1', displayName: 'Drop' });
    await userDefaultApp.setDefault({ ownerSub: 'user-1', appId: keep.appId });

    const result = await handler.handler({ appId: drop.appId }, makeCtx());

    expect(result).toEqual({ deleted: true });
    expect((await apps.list('user-1')).map((r) => r.appId)).toEqual([
      keep.appId,
    ]);
    // The lock must not be a blanket "a default exists" refusal.
    expect(await userDefaultApp.getDefault('user-1')).toBe(keep.appId);
  });
});

describe('createDeleteAppHandler — idempotent', () => {
  it('returns {deleted: true} when the id does not exist', async () => {
    const { handler } = makeHandler();
    const result = await handler.handler({ appId: 'app_nope' }, makeCtx());
    expect(result).toEqual({ deleted: true });
  });
});

describe('createDeleteAppHandler — tenancy', () => {
  it('returns {deleted: true} on cross-user probe WITHOUT touching the row', async () => {
    const { apps, handler } = makeHandler();
    const other = await apps.create({
      ownerSub: 'user-2',
      displayName: 'Theirs',
    });
    const result = await handler.handler(
      { appId: other.appId },
      makeCtx({ userId: 'user-1' }),
    );
    expect(result).toEqual({ deleted: true });
    // The row MUST still exist under user-2.
    const list = await apps.list('user-2');
    expect(list).toHaveLength(1);
  });

  it('answers the uniform shape when the caller’s OWN default names a foreign app', async () => {
    // The one state where the lock's placement is observable, so the
    // only one that pins it. `getDefault` reads the caller's own row
    // and could never return another tenant's default, whatever the
    // ordering — what ordering decides is which SHAPE comes back here.
    // Ownership-first answers with the uniform `{deleted: true}` every
    // foreign id gets; lock-first answers `default_app_delete_blocked`,
    // and that difference is itself the signal.
    //
    // A stale default pointing at someone else's app is reachable in
    // practice: the app was deleted and its id reused, or the column
    // was written before ownership moved.
    const { apps, userDefaultApp, handler } = makeHandler();
    const theirs = await apps.create({
      ownerSub: 'user-2',
      displayName: 'Theirs',
    });
    await userDefaultApp.setDefault({
      ownerSub: 'user-1',
      appId: theirs.appId,
    });

    const result = await handler.handler(
      { appId: theirs.appId },
      makeCtx({ userId: 'user-1' }),
    );

    expect(result).toEqual({ deleted: true });
    expect(await apps.list('user-2')).toHaveLength(1);
  });
});

describe('createDeleteAppHandler — default-app lock', () => {
  it('REJECTS deleting the caller’s default app and leaves the row', async () => {
    const { apps, userDefaultApp, handler } = makeHandler();
    const created = await apps.create({
      ownerSub: 'user-1',
      displayName: 'Default',
    });
    await userDefaultApp.setDefault({
      ownerSub: 'user-1',
      appId: created.appId,
    });

    await expect(
      handler.handler({ appId: created.appId }, makeCtx()),
    ).rejects.toThrow(DefaultAppDeleteBlockedError);

    // Rejection means the row survives — otherwise the lock would be a
    // message rather than a guard.
    expect((await apps.list('user-1')).map((r) => r.appId)).toEqual([
      created.appId,
    ]);
  });

  it('carries the stable `default_app_delete_blocked` code', async () => {
    const { apps, userDefaultApp, handler } = makeHandler();
    const created = await apps.create({ ownerSub: 'user-1', displayName: 'D' });
    await userDefaultApp.setDefault({
      ownerSub: 'user-1',
      appId: created.appId,
    });

    const err = await handler
      .handler({ appId: created.appId }, makeCtx())
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(DefaultAppDeleteBlockedError);
    expect((err as DefaultAppDeleteBlockedError).code).toBe(
      'default_app_delete_blocked',
    );
  });

  it('deletes once the default has been moved elsewhere', async () => {
    const { apps, userDefaultApp, handler } = makeHandler();
    const a = await apps.create({ ownerSub: 'user-1', displayName: 'A' });
    const b = await apps.create({ ownerSub: 'user-1', displayName: 'B' });
    await userDefaultApp.setDefault({ ownerSub: 'user-1', appId: a.appId });

    await expect(
      handler.handler({ appId: a.appId }, makeCtx()),
    ).rejects.toBeInstanceOf(DefaultAppDeleteBlockedError);

    await userDefaultApp.setDefault({ ownerSub: 'user-1', appId: b.appId });
    await expect(
      handler.handler({ appId: a.appId }, makeCtx()),
    ).resolves.toEqual({ deleted: true });
  });
});

describe('createDeleteAppHandler — the wire description matches behavior', () => {
  // #451: the shipped description claimed "Cascades per-app keys /
  // blueprints / renders at the cloud adapter layer" while the bound
  // adapter issued one DeleteItem on the app row. The description is
  // read by every LLM that lists this tool, so a false claim there is
  // a wire-level defect, not a comment. These pins fail if the claim
  // comes back.
  const { handler } = makeHandler();

  it('makes NO cascade claim', () => {
    expect(handler.description).not.toMatch(/cascad/i);
  });

  it('says what it removes and what it does not', () => {
    expect(handler.description).toMatch(/APP RECORD only/);
    expect(handler.description).toMatch(/is not removed by this call/);
  });

  it('names the default-app rejection it actually performs', () => {
    expect(handler.description).toContain('default_app_delete_blocked');
  });

  it('keeps the tenancy + idempotency claims that ARE true', () => {
    expect(handler.description).toMatch(/[Ii]dempotent/);
    expect(handler.description).toMatch(/no existence leak/);
  });
});
