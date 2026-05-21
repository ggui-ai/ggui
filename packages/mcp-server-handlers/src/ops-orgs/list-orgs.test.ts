import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createListOrgsHandler } from './list-orgs.js';
import { InMemoryOrgsSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createListOrgsHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createListOrgsHandler({
      orgs: new InMemoryOrgsSource(),
    });
    expect(handler.name).toBe('ggui_ops_list_orgs');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createListOrgsHandler — happy path', () => {
  it('returns owner + admin + member memberships in one list', async () => {
    const orgs = new InMemoryOrgsSource();
    const own = await orgs.create({ ownerSub: 'user-1', name: 'Mine' });
    const other = await orgs.create({ ownerSub: 'user-2', name: 'Other' });
    orgs.seedMembership({
      orgId: other.orgId,
      userId: 'user-1',
      role: 'admin',
    });
    const third = await orgs.create({ ownerSub: 'user-3', name: 'Third' });
    orgs.seedMembership({
      orgId: third.orgId,
      userId: 'user-1',
      role: 'member',
    });
    const handler = createListOrgsHandler({ orgs });
    const result = await handler.handler({}, makeCtx());
    expect(result.orgs).toHaveLength(3);
    const roles = result.orgs.map((o) => o.role).sort();
    expect(roles).toEqual(['admin', 'member', 'owner']);
    expect(result.orgs.find((o) => o.orgId === own.orgId)?.role).toBe(
      'owner',
    );
  });

  it('returns an empty list when the user has no memberships', async () => {
    const handler = createListOrgsHandler({ orgs: new InMemoryOrgsSource() });
    const result = await handler.handler({}, makeCtx());
    expect(result.orgs).toEqual([]);
  });
});

describe('createListOrgsHandler — identity', () => {
  it('throws on empty identity', async () => {
    const handler = createListOrgsHandler({ orgs: new InMemoryOrgsSource() });
    await expect(
      handler.handler({}, { appId: '', requestId: 'r' }),
    ).rejects.toThrow();
  });
});
