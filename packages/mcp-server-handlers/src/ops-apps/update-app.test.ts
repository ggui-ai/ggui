import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { AppNotFoundError } from './types.js';
import { createUpdateAppHandler } from './update-app.js';
import { InMemoryAppsSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createUpdateAppHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createUpdateAppHandler({
      apps: new InMemoryAppsSource(),
    });
    expect(handler.name).toBe('ggui_ops_update_app');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createUpdateAppHandler — happy paths', () => {
  it('updates displayName on the targeted row', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({
      ownerSub: 'user-1',
      displayName: 'Old',
    });
    const handler = createUpdateAppHandler({ apps });
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

  it('sets and clears the systemPrompt via the empty-string sentinel', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({ ownerSub: 'user-1' });
    const handler = createUpdateAppHandler({ apps });
    const set = await handler.handler(
      { appId: created.appId, systemPrompt: 'Be terse.' },
      makeCtx(),
    );
    expect(set.systemPrompt).toBe('Be terse.');
    const cleared = await handler.handler(
      { appId: created.appId, systemPrompt: '' },
      makeCtx(),
    );
    expect(cleared.systemPrompt).toBeUndefined();
    const stored = await apps.get({
      appId: created.appId,
      ownerSub: 'user-1',
    });
    expect(stored?.systemPrompt).toBeUndefined();
  });

  it('sets and clears rateLimitPerMinute via the 0 sentinel (0 → unlimited)', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({ ownerSub: 'user-1' });
    const handler = createUpdateAppHandler({ apps });
    const set = await handler.handler(
      { appId: created.appId, rateLimitPerMinute: 30 },
      makeCtx(),
    );
    expect(set.rateLimitPerMinute).toBe(30);
    const cleared = await handler.handler(
      { appId: created.appId, rateLimitPerMinute: 0 },
      makeCtx(),
    );
    // One representation of "unlimited": the field is ABSENT.
    expect(cleared.rateLimitPerMinute).toBeUndefined();
    const stored = await apps.get({
      appId: created.appId,
      ownerSub: 'user-1',
    });
    expect(stored?.rateLimitPerMinute).toBeUndefined();
  });

  it('applies several fields in one call', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({
      ownerSub: 'user-1',
      displayName: 'Old',
    });
    const handler = createUpdateAppHandler({ apps });
    const result = await handler.handler(
      {
        appId: created.appId,
        displayName: 'New',
        systemPrompt: 'Be kind.',
        rateLimitPerMinute: 12,
      },
      makeCtx(),
    );
    expect(result.displayName).toBe('New');
    expect(result.systemPrompt).toBe('Be kind.');
    expect(result.rateLimitPerMinute).toBe(12);
  });

  it('leaves untouched fields untouched', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({
      ownerSub: 'user-1',
      displayName: 'Keep me',
    });
    const handler = createUpdateAppHandler({ apps });
    await handler.handler(
      { appId: created.appId, systemPrompt: 'Prompt' },
      makeCtx(),
    );
    const result = await handler.handler(
      { appId: created.appId, rateLimitPerMinute: 5 },
      makeCtx(),
    );
    expect(result.displayName).toBe('Keep me');
    expect(result.systemPrompt).toBe('Prompt');
    expect(result.rateLimitPerMinute).toBe(5);
  });
});

describe('createUpdateAppHandler — validation', () => {
  it('rejects an empty update (no fields supplied)', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({ ownerSub: 'user-1' });
    const handler = createUpdateAppHandler({ apps });
    await expect(
      handler.handler({ appId: created.appId }, makeCtx()),
    ).rejects.toThrow(/at least one of/);
  });

  it('rejects a negative rateLimitPerMinute', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({ ownerSub: 'user-1' });
    const handler = createUpdateAppHandler({ apps });
    await expect(
      handler.handler(
        { appId: created.appId, rateLimitPerMinute: -1 },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-integer rateLimitPerMinute', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({ ownerSub: 'user-1' });
    const handler = createUpdateAppHandler({ apps });
    await expect(
      handler.handler(
        { appId: created.appId, rateLimitPerMinute: 2.5 },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });
});

describe('createUpdateAppHandler — not found', () => {
  it('throws AppNotFoundError when the id is unknown', async () => {
    const handler = createUpdateAppHandler({
      apps: new InMemoryAppsSource(),
    });
    await expect(
      handler.handler({ appId: 'app_nope', displayName: 'X' }, makeCtx()),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });
});

describe('createUpdateAppHandler — tenancy', () => {
  it('rejects cross-user updates with the uniform AppNotFoundError', async () => {
    const apps = new InMemoryAppsSource();
    const other = await apps.create({
      ownerSub: 'user-2',
      displayName: 'Theirs',
    });
    const handler = createUpdateAppHandler({ apps });
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
    const handler = createUpdateAppHandler({
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
