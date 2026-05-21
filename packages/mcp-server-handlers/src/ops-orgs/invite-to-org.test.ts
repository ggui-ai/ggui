import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createInviteToOrgHandler } from './invite-to-org.js';
import {
  InMemoryOrgInvitesSource,
  InMemoryOrgsSource,
} from './in-memory-fake.test-util.js';
import { OrgInviteAccessDeniedError } from './types.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createInviteToOrgHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const orgs = new InMemoryOrgsSource();
    const handler = createInviteToOrgHandler({
      invites: new InMemoryOrgInvitesSource(orgs),
    });
    expect(handler.name).toBe('ggui_ops_invite_to_org');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createInviteToOrgHandler — happy path', () => {
  it('mints a pending invite when caller is owner', async () => {
    const orgs = new InMemoryOrgsSource();
    const invites = new InMemoryOrgInvitesSource(orgs);
    const org = await orgs.create({ ownerSub: 'user-1', name: 'Acme' });
    const handler = createInviteToOrgHandler({ invites });
    const result = await handler.handler(
      { orgId: org.orgId, email: 'new@example.com', role: 'member' },
      makeCtx(),
    );
    expect(result.status).toBe('pending');
    expect(result.email).toBe('new@example.com');
    expect(result.role).toBe('member');
    expect(result.reused).toBe(false);
  });

  it('reuses a pending invite for the same (orgId, email) pair', async () => {
    const orgs = new InMemoryOrgsSource();
    const invites = new InMemoryOrgInvitesSource(orgs);
    const org = await orgs.create({ ownerSub: 'user-1', name: 'Acme' });
    const handler = createInviteToOrgHandler({ invites });
    const first = await handler.handler(
      { orgId: org.orgId, email: 'new@example.com', role: 'member' },
      makeCtx(),
    );
    const second = await handler.handler(
      { orgId: org.orgId, email: 'new@example.com', role: 'admin' },
      makeCtx(),
    );
    expect(second.inviteId).toBe(first.inviteId);
    expect(second.reused).toBe(true);
  });
});

describe('createInviteToOrgHandler — access denial', () => {
  it('rejects when caller is not owner/admin of the org', async () => {
    const orgs = new InMemoryOrgsSource();
    const invites = new InMemoryOrgInvitesSource(orgs);
    const org = await orgs.create({ ownerSub: 'user-2', name: 'Theirs' });
    const handler = createInviteToOrgHandler({ invites });
    await expect(
      handler.handler(
        { orgId: org.orgId, email: 'x@example.com', role: 'member' },
        makeCtx({ userId: 'user-1' }),
      ),
    ).rejects.toBeInstanceOf(OrgInviteAccessDeniedError);
  });
});

describe('createInviteToOrgHandler — input validation', () => {
  it('rejects malformed email', async () => {
    const orgs = new InMemoryOrgsSource();
    const invites = new InMemoryOrgInvitesSource(orgs);
    const org = await orgs.create({ ownerSub: 'user-1', name: 'Acme' });
    const handler = createInviteToOrgHandler({ invites });
    await expect(
      handler.handler(
        { orgId: org.orgId, email: 'not-an-email', role: 'member' },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });
});
