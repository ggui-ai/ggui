import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createCreateOrgHandler } from './create-org.js';
import { InMemoryOrgsSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createCreateOrgHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createCreateOrgHandler({
      orgs: new InMemoryOrgsSource(),
    });
    expect(handler.name).toBe('ggui_ops_create_org');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createCreateOrgHandler — happy path', () => {
  it('mints an org owned by the caller', async () => {
    const orgs = new InMemoryOrgsSource();
    const handler = createCreateOrgHandler({ orgs });
    const result = await handler.handler({ name: 'Acme' }, makeCtx());
    expect(result.name).toBe('Acme');
    expect(result.ownerUserId).toBe('user-1');
    expect(result.orgId).toMatch(/^org_/);
    // The caller is auto-listed as owner of the new org.
    const memberships = await orgs.listMemberships('user-1');
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('owner');
  });
});

describe('createCreateOrgHandler — input validation', () => {
  it('rejects empty name', async () => {
    const handler = createCreateOrgHandler({
      orgs: new InMemoryOrgsSource(),
    });
    await expect(
      handler.handler({ name: '' }, makeCtx()),
    ).rejects.toThrow();
  });

  it('throws on empty identity', async () => {
    const handler = createCreateOrgHandler({
      orgs: new InMemoryOrgsSource(),
    });
    await expect(
      handler.handler({ name: 'x' }, { appId: '', requestId: 'r' }),
    ).rejects.toThrow();
  });
});
