import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createRemoveOrgMemberHandler } from './remove-org-member.js';
import { InMemoryOrgsSource } from './in-memory-fake.test-util.js';
import { OrgMemberRemovalDeniedError, OrgNotFoundError } from './types.js';

function makeCtx(userId: string): HandlerContext {
  return { appId: userId, requestId: 'req-1', userId };
}

async function seededOrg() {
  const orgs = new InMemoryOrgsSource();
  const org = await orgs.create({ ownerSub: 'owner-1', name: 'Org' });
  orgs.seedMembership({ orgId: org.orgId, userId: 'admin-1', role: 'admin' });
  orgs.seedMembership({ orgId: org.orgId, userId: 'admin-2', role: 'admin' });
  orgs.seedMembership({ orgId: org.orgId, userId: 'member-1', role: 'member' });
  orgs.seedMembership({ orgId: org.orgId, userId: 'member-2', role: 'member' });
  return { orgs, org };
}

describe('createRemoveOrgMemberHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createRemoveOrgMemberHandler({
      orgs: new InMemoryOrgsSource(),
    });
    expect(handler.name).toBe('ggui_ops_remove_org_member');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createRemoveOrgMemberHandler — permission matrix', () => {
  it('owner removes an admin', async () => {
    const { orgs, org } = await seededOrg();
    const handler = createRemoveOrgMemberHandler({ orgs });
    const result = await handler.handler(
      { orgId: org.orgId, memberUserId: 'admin-1' },
      makeCtx('owner-1'),
    );
    expect(result.alreadyAbsent).toBe(false);
    expect(orgs.findMembership(org.orgId, 'admin-1')).toBeUndefined();
  });

  it('owner removes a member', async () => {
    const { orgs, org } = await seededOrg();
    const handler = createRemoveOrgMemberHandler({ orgs });
    const result = await handler.handler(
      { orgId: org.orgId, memberUserId: 'member-1' },
      makeCtx('owner-1'),
    );
    expect(result.alreadyAbsent).toBe(false);
  });

  it('the owner can never be removed — even by the owner', async () => {
    const { orgs, org } = await seededOrg();
    const handler = createRemoveOrgMemberHandler({ orgs });
    for (const caller of ['owner-1', 'admin-1', 'member-1']) {
      await expect(
        handler.handler(
          { orgId: org.orgId, memberUserId: 'owner-1' },
          makeCtx(caller),
        ),
      ).rejects.toBeInstanceOf(OrgMemberRemovalDeniedError);
    }
    expect(orgs.findMembership(org.orgId, 'owner-1')).toBeDefined();
  });

  it('admin removes a member', async () => {
    const { orgs, org } = await seededOrg();
    const handler = createRemoveOrgMemberHandler({ orgs });
    const result = await handler.handler(
      { orgId: org.orgId, memberUserId: 'member-1' },
      makeCtx('admin-1'),
    );
    expect(result.alreadyAbsent).toBe(false);
  });

  it('admin removes self (leave org)', async () => {
    const { orgs, org } = await seededOrg();
    const handler = createRemoveOrgMemberHandler({ orgs });
    const result = await handler.handler(
      { orgId: org.orgId, memberUserId: 'admin-1' },
      makeCtx('admin-1'),
    );
    expect(result.alreadyAbsent).toBe(false);
    expect(orgs.findMembership(org.orgId, 'admin-1')).toBeUndefined();
  });

  it('admin cannot remove another admin', async () => {
    const { orgs, org } = await seededOrg();
    const handler = createRemoveOrgMemberHandler({ orgs });
    await expect(
      handler.handler(
        { orgId: org.orgId, memberUserId: 'admin-2' },
        makeCtx('admin-1'),
      ),
    ).rejects.toBeInstanceOf(OrgMemberRemovalDeniedError);
    expect(orgs.findMembership(org.orgId, 'admin-2')).toBeDefined();
  });

  it('member removes self (leave org)', async () => {
    const { orgs, org } = await seededOrg();
    const handler = createRemoveOrgMemberHandler({ orgs });
    const result = await handler.handler(
      { orgId: org.orgId, memberUserId: 'member-1' },
      makeCtx('member-1'),
    );
    expect(result.alreadyAbsent).toBe(false);
  });

  it('member cannot remove anyone else', async () => {
    const { orgs, org } = await seededOrg();
    const handler = createRemoveOrgMemberHandler({ orgs });
    await expect(
      handler.handler(
        { orgId: org.orgId, memberUserId: 'member-2' },
        makeCtx('member-1'),
      ),
    ).rejects.toBeInstanceOf(OrgMemberRemovalDeniedError);
  });
});

describe('createRemoveOrgMemberHandler — idempotency + tenancy', () => {
  it('absent target resolves with alreadyAbsent: true', async () => {
    const { orgs, org } = await seededOrg();
    const handler = createRemoveOrgMemberHandler({ orgs });
    const result = await handler.handler(
      { orgId: org.orgId, memberUserId: 'ghost' },
      makeCtx('owner-1'),
    );
    expect(result.alreadyAbsent).toBe(true);
  });

  it('non-member callers get the uniform OrgNotFoundError', async () => {
    const { orgs, org } = await seededOrg();
    const handler = createRemoveOrgMemberHandler({ orgs });
    await expect(
      handler.handler(
        { orgId: org.orgId, memberUserId: 'member-1' },
        makeCtx('outsider'),
      ),
    ).rejects.toBeInstanceOf(OrgNotFoundError);
    expect(orgs.findMembership(org.orgId, 'member-1')).toBeDefined();
  });

  it('a missing orgId answers with the SAME error class as a foreign org', async () => {
    const handler = createRemoveOrgMemberHandler({
      orgs: new InMemoryOrgsSource(),
    });
    await expect(
      handler.handler(
        { orgId: 'org_nope', memberUserId: 'x' },
        makeCtx('user-1'),
      ),
    ).rejects.toBeInstanceOf(OrgNotFoundError);
  });
});
