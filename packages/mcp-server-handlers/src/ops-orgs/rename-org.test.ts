import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createRenameOrgHandler } from './rename-org.js';
import { InMemoryOrgsSource } from './in-memory-fake.test-util.js';
import { OrgAccessDeniedError, OrgNotFoundError } from './types.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createRenameOrgHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createRenameOrgHandler({
      orgs: new InMemoryOrgsSource(),
    });
    expect(handler.name).toBe('ggui_ops_rename_org');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createRenameOrgHandler — authz', () => {
  it('owner renames', async () => {
    const orgs = new InMemoryOrgsSource();
    const org = await orgs.create({ ownerSub: 'user-1', name: 'Old' });
    const handler = createRenameOrgHandler({ orgs });
    const result = await handler.handler(
      { orgId: org.orgId, name: 'New' },
      makeCtx(),
    );
    expect(result.name).toBe('New');
    const listed = await orgs.listMemberships('user-1');
    expect(listed[0]?.name).toBe('New');
  });

  it('admin renames', async () => {
    const orgs = new InMemoryOrgsSource();
    const org = await orgs.create({ ownerSub: 'user-2', name: 'Old' });
    orgs.seedMembership({ orgId: org.orgId, userId: 'user-1', role: 'admin' });
    const handler = createRenameOrgHandler({ orgs });
    const result = await handler.handler(
      { orgId: org.orgId, name: 'By admin' },
      makeCtx(),
    );
    expect(result.name).toBe('By admin');
  });

  it('member-role callers are rejected with OrgAccessDeniedError', async () => {
    const orgs = new InMemoryOrgsSource();
    const org = await orgs.create({ ownerSub: 'user-2', name: 'Old' });
    orgs.seedMembership({ orgId: org.orgId, userId: 'user-1', role: 'member' });
    const handler = createRenameOrgHandler({ orgs });
    await expect(
      handler.handler({ orgId: org.orgId, name: 'Nope' }, makeCtx()),
    ).rejects.toBeInstanceOf(OrgAccessDeniedError);
  });

  it('non-members get the uniform OrgNotFoundError (no existence leak)', async () => {
    const orgs = new InMemoryOrgsSource();
    const org = await orgs.create({ ownerSub: 'user-2', name: 'Theirs' });
    const handler = createRenameOrgHandler({ orgs });
    await expect(
      handler.handler({ orgId: org.orgId, name: 'Probe' }, makeCtx()),
    ).rejects.toBeInstanceOf(OrgNotFoundError);
    // Row untouched
    const theirs = await orgs.listMemberships('user-2');
    expect(theirs[0]?.name).toBe('Theirs');
  });

  it('a missing orgId answers with the SAME error class as a foreign org', async () => {
    const handler = createRenameOrgHandler({
      orgs: new InMemoryOrgsSource(),
    });
    await expect(
      handler.handler({ orgId: 'org_nope', name: 'X' }, makeCtx()),
    ).rejects.toBeInstanceOf(OrgNotFoundError);
  });
});

describe('createRenameOrgHandler — validation', () => {
  it('rejects an empty name at the schema layer', async () => {
    const orgs = new InMemoryOrgsSource();
    const org = await orgs.create({ ownerSub: 'user-1', name: 'Old' });
    const handler = createRenameOrgHandler({ orgs });
    await expect(
      handler.handler({ orgId: org.orgId, name: '' }, makeCtx()),
    ).rejects.toThrow();
  });
});
