import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createRevokeInviteHandler } from './revoke-invite.js';
import {
  InMemoryOrgInvitesSource,
  InMemoryOrgsSource,
} from './in-memory-fake.test-util.js';
import {
  OrgInviteAccessDeniedError,
  OrgInviteNotFoundError,
} from './types.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createRevokeInviteHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const orgs = new InMemoryOrgsSource();
    const handler = createRevokeInviteHandler({
      invites: new InMemoryOrgInvitesSource(orgs),
    });
    expect(handler.name).toBe('ggui_ops_revoke_invite');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createRevokeInviteHandler — happy path', () => {
  it('flips status from pending → revoked', async () => {
    const orgs = new InMemoryOrgsSource();
    const invites = new InMemoryOrgInvitesSource(orgs);
    const org = await orgs.create({ ownerSub: 'user-1', name: 'Acme' });
    const { invite } = await invites.issue({
      ownerSub: 'user-1',
      orgId: org.orgId,
      email: 'x@example.com',
      role: 'member',
    });
    const handler = createRevokeInviteHandler({ invites });
    const result = await handler.handler(
      { inviteId: invite.inviteId },
      makeCtx(),
    );
    expect(result.status).toBe('revoked');
    expect(result.alreadyRevoked).toBe(false);
  });

  it('is idempotent for already-revoked invites', async () => {
    const orgs = new InMemoryOrgsSource();
    const invites = new InMemoryOrgInvitesSource(orgs);
    const org = await orgs.create({ ownerSub: 'user-1', name: 'Acme' });
    const { invite } = await invites.issue({
      ownerSub: 'user-1',
      orgId: org.orgId,
      email: 'x@example.com',
      role: 'member',
    });
    const handler = createRevokeInviteHandler({ invites });
    await handler.handler({ inviteId: invite.inviteId }, makeCtx());
    const second = await handler.handler(
      { inviteId: invite.inviteId },
      makeCtx(),
    );
    expect(second.alreadyRevoked).toBe(true);
    expect(second.status).toBe('revoked');
  });
});

describe('createRevokeInviteHandler — access denial + not found', () => {
  it('rejects unknown inviteIds with OrgInviteNotFoundError', async () => {
    const orgs = new InMemoryOrgsSource();
    const invites = new InMemoryOrgInvitesSource(orgs);
    const handler = createRevokeInviteHandler({ invites });
    await expect(
      handler.handler({ inviteId: 'inv_nope' }, makeCtx()),
    ).rejects.toBeInstanceOf(OrgInviteNotFoundError);
  });

  it('rejects when caller is not owner/admin of the invite’s org', async () => {
    const orgs = new InMemoryOrgsSource();
    const invites = new InMemoryOrgInvitesSource(orgs);
    const org = await orgs.create({ ownerSub: 'user-2', name: 'Theirs' });
    const { invite } = await invites.issue({
      ownerSub: 'user-2',
      orgId: org.orgId,
      email: 'x@example.com',
      role: 'member',
    });
    const handler = createRevokeInviteHandler({ invites });
    await expect(
      handler.handler(
        { inviteId: invite.inviteId },
        makeCtx({ userId: 'user-1' }),
      ),
    ).rejects.toBeInstanceOf(OrgInviteAccessDeniedError);
  });
});
