import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createGetOrgBalanceHandler } from './get-org-balance.js';
import { InMemoryOrgsSource } from './in-memory-fake.test-util.js';
import { OrgNotFoundError } from './types.js';

function makeCtx(userId: string): HandlerContext {
  return { appId: userId, requestId: 'req-1', userId };
}

describe('createGetOrgBalanceHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createGetOrgBalanceHandler({
      orgs: new InMemoryOrgsSource(),
    });
    expect(handler.name).toBe('ggui_ops_get_org_balance');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createGetOrgBalanceHandler — reads', () => {
  it('every membership role can read the balance', async () => {
    const orgs = new InMemoryOrgsSource();
    const org = await orgs.create({ ownerSub: 'owner-1', name: 'Org' });
    orgs.seedMembership({ orgId: org.orgId, userId: 'admin-1', role: 'admin' });
    orgs.seedMembership({
      orgId: org.orgId,
      userId: 'member-1',
      role: 'member',
    });
    orgs.seedBalance({
      orgId: org.orgId,
      balanceCents: 1234,
      lifetimeGrantedCents: 2000,
      lifetimeSpentCents: 766,
      updatedAt: new Date(42).toISOString(),
    });
    const handler = createGetOrgBalanceHandler({ orgs });
    for (const caller of ['owner-1', 'admin-1', 'member-1']) {
      const result = await handler.handler(
        { orgId: org.orgId },
        makeCtx(caller),
      );
      expect(result.balanceCents).toBe(1234);
      expect(result.lifetimeGrantedCents).toBe(2000);
      expect(result.lifetimeSpentCents).toBe(766);
    }
  });

  it('freshly-created orgs read zeros', async () => {
    const orgs = new InMemoryOrgsSource();
    const org = await orgs.create({ ownerSub: 'owner-1', name: 'Org' });
    const handler = createGetOrgBalanceHandler({ orgs });
    const result = await handler.handler(
      { orgId: org.orgId },
      makeCtx('owner-1'),
    );
    expect(result.balanceCents).toBe(0);
    expect(result.lifetimeGrantedCents).toBe(0);
    expect(result.lifetimeSpentCents).toBe(0);
  });
});

describe('createGetOrgBalanceHandler — tenancy', () => {
  it('non-members get the uniform OrgNotFoundError', async () => {
    const orgs = new InMemoryOrgsSource();
    const org = await orgs.create({ ownerSub: 'owner-1', name: 'Org' });
    const handler = createGetOrgBalanceHandler({ orgs });
    await expect(
      handler.handler({ orgId: org.orgId }, makeCtx('outsider')),
    ).rejects.toBeInstanceOf(OrgNotFoundError);
  });

  it('a missing orgId answers with the SAME error class as a foreign org', async () => {
    const handler = createGetOrgBalanceHandler({
      orgs: new InMemoryOrgsSource(),
    });
    await expect(
      handler.handler({ orgId: 'org_nope' }, makeCtx('user-1')),
    ).rejects.toBeInstanceOf(OrgNotFoundError);
  });
});
