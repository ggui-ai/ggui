/**
 * In-memory fakes for the `OrgsSource` + `OrgInvitesSource` seams,
 * shared across `ops-orgs` test files.
 */

import type {
  OrgBalanceRecord,
  OrgInviteRecord,
  OrgInvitesSource,
  OrgMembershipRecord,
  OrgRecord,
  OrgRole,
  OrgsSource,
} from './types.js';
import {
  OrgAccessDeniedError,
  OrgInviteAccessDeniedError,
  OrgInviteNotFoundError,
  OrgMemberRemovalDeniedError,
  OrgNotFoundError,
} from './types.js';

interface MembershipRow {
  readonly orgId: string;
  readonly userId: string;
  readonly role: OrgRole;
  readonly joinedAt: string;
}

const ORG_NAME_MAX_LEN = 120;

export class InMemoryOrgsSource implements OrgsSource {
  private readonly orgs = new Map<string, OrgRecord>();
  private memberships: MembershipRow[] = [];
  private readonly balances = new Map<string, OrgBalanceRecord>();
  private idCounter = 0;
  private clock = 0;

  private now(): string {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }

  async listMemberships(
    ownerSub: string,
  ): Promise<readonly OrgMembershipRecord[]> {
    return this.memberships
      .filter((m) => m.userId === ownerSub)
      .map((m): OrgMembershipRecord => {
        const org = this.orgs.get(m.orgId);
        if (!org) {
          // Should not happen — invariants kept aligned in tests.
          throw new Error(
            `InMemoryOrgsSource: dangling membership for ${m.orgId}`,
          );
        }
        return {
          orgId: org.orgId,
          name: org.name,
          ownerUserId: org.ownerUserId,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      });
  }

  async create(args: {
    ownerSub: string;
    name: string;
  }): Promise<OrgRecord> {
    this.idCounter += 1;
    const orgId = `org_${this.idCounter.toString(36).padStart(8, '0')}`;
    const now = this.now();
    const row: OrgRecord = {
      orgId,
      name: args.name,
      ownerUserId: args.ownerSub,
      createdAt: now,
      updatedAt: now,
    };
    this.orgs.set(orgId, row);
    this.memberships.push({
      orgId,
      userId: args.ownerSub,
      role: 'owner',
      joinedAt: now,
    });
    this.balances.set(orgId, {
      orgId,
      balanceCents: 0,
      lifetimeGrantedCents: 0,
      lifetimeSpentCents: 0,
      updatedAt: now,
    });
    return row;
  }

  async rename(args: {
    ownerSub: string;
    orgId: string;
    name: string;
  }): Promise<{ orgId: string; name: string; updatedAt: string }> {
    const membership = this.findMembership(args.orgId, args.ownerSub);
    if (!membership) {
      throw new OrgNotFoundError(args.orgId);
    }
    if (membership.role !== 'owner' && membership.role !== 'admin') {
      throw new OrgAccessDeniedError(
        `org_access_denied: renaming org ${args.orgId} requires owner or admin role`,
      );
    }
    const org = this.orgs.get(args.orgId);
    if (!org) {
      throw new OrgNotFoundError(args.orgId);
    }
    const trimmed = args.name.trim();
    if (trimmed.length === 0) {
      throw new Error('rename: name must be non-empty');
    }
    const next: OrgRecord = {
      ...org,
      name: trimmed.slice(0, ORG_NAME_MAX_LEN),
      updatedAt: this.now(),
    };
    this.orgs.set(args.orgId, next);
    return { orgId: next.orgId, name: next.name, updatedAt: next.updatedAt };
  }

  async removeMember(args: {
    ownerSub: string;
    orgId: string;
    memberUserId: string;
  }): Promise<{ orgId: string; memberUserId: string; alreadyAbsent: boolean }> {
    const caller = this.findMembership(args.orgId, args.ownerSub);
    if (!caller) {
      throw new OrgNotFoundError(args.orgId);
    }
    const target = this.findMembership(args.orgId, args.memberUserId);
    if (!target) {
      return {
        orgId: args.orgId,
        memberUserId: args.memberUserId,
        alreadyAbsent: true,
      };
    }
    if (target.role === 'owner') {
      throw new OrgMemberRemovalDeniedError(
        'org_member_removal_denied: cannot remove the org owner — transfer ownership first',
      );
    }
    const isSelf = caller.userId === target.userId;
    if (caller.role === 'admin' && target.role === 'admin' && !isSelf) {
      throw new OrgMemberRemovalDeniedError(
        'org_member_removal_denied: admins cannot remove other admins',
      );
    }
    if (caller.role === 'member' && !isSelf) {
      throw new OrgMemberRemovalDeniedError(
        'org_member_removal_denied: members can only remove themselves',
      );
    }
    this.memberships = this.memberships.filter(
      (m) => !(m.orgId === args.orgId && m.userId === args.memberUserId),
    );
    return {
      orgId: args.orgId,
      memberUserId: args.memberUserId,
      alreadyAbsent: false,
    };
  }

  async getBalance(args: {
    ownerSub: string;
    orgId: string;
  }): Promise<OrgBalanceRecord> {
    const membership = this.findMembership(args.orgId, args.ownerSub);
    if (!membership) {
      throw new OrgNotFoundError(args.orgId);
    }
    return (
      this.balances.get(args.orgId) ?? {
        orgId: args.orgId,
        balanceCents: 0,
        lifetimeGrantedCents: 0,
        lifetimeSpentCents: 0,
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  /** Test helper: seed a membership row (e.g. admin/member) for an
   * already-existing org. */
  seedMembership(args: {
    orgId: string;
    userId: string;
    role: OrgRole;
  }): void {
    this.memberships.push({
      orgId: args.orgId,
      userId: args.userId,
      role: args.role,
      joinedAt: this.now(),
    });
  }

  /** Test helper: overwrite an org's balance row. */
  seedBalance(balance: OrgBalanceRecord): void {
    this.balances.set(balance.orgId, balance);
  }

  /** Test introspection: lookup membership row. */
  findMembership(orgId: string, userId: string): MembershipRow | undefined {
    return this.memberships.find(
      (m) => m.orgId === orgId && m.userId === userId,
    );
  }
}

export class InMemoryOrgInvitesSource implements OrgInvitesSource {
  private readonly invites = new Map<string, OrgInviteRecord>();
  private idCounter = 0;
  private clock = 0;

  constructor(private readonly orgs: InMemoryOrgsSource) {}

  private now(): string {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }

  private requireAdminAccess(orgId: string, ownerSub: string): void {
    const m = this.orgs.findMembership(orgId, ownerSub);
    if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
      throw new OrgInviteAccessDeniedError(
        `caller ${ownerSub} is not owner/admin of org ${orgId}`,
      );
    }
  }

  async issue(args: {
    ownerSub: string;
    orgId: string;
    email: string;
    role: 'admin' | 'member';
  }): Promise<{ invite: OrgInviteRecord; reused: boolean }> {
    this.requireAdminAccess(args.orgId, args.ownerSub);
    // Anti-double-issue
    for (const existing of this.invites.values()) {
      if (
        existing.orgId === args.orgId &&
        existing.email === args.email &&
        existing.status === 'pending'
      ) {
        return { invite: existing, reused: true };
      }
    }
    this.idCounter += 1;
    const inviteId = `inv_${this.idCounter.toString(36).padStart(8, '0')}`;
    const now = this.now();
    const invite: OrgInviteRecord = {
      inviteId,
      orgId: args.orgId,
      email: args.email,
      role: args.role,
      inviterUserId: args.ownerSub,
      status: 'pending',
      expiresAt: new Date(this.clock + 7 * 24 * 3600 * 1000).toISOString(),
      createdAt: now,
    };
    this.invites.set(inviteId, invite);
    return { invite, reused: false };
  }

  async revoke(args: {
    ownerSub: string;
    inviteId: string;
  }): Promise<{ invite: OrgInviteRecord; alreadyRevoked: boolean }> {
    const existing = this.invites.get(args.inviteId);
    if (!existing) {
      throw new OrgInviteNotFoundError(args.inviteId);
    }
    this.requireAdminAccess(existing.orgId, args.ownerSub);
    if (existing.status === 'revoked') {
      return { invite: existing, alreadyRevoked: true };
    }
    if (existing.status !== 'pending') {
      // Already accepted / expired — surface a clear conflict.
      throw new Error(
        `org_invite_invalid_state: invite ${args.inviteId} status=${existing.status}`,
      );
    }
    const next: OrgInviteRecord = { ...existing, status: 'revoked' };
    this.invites.set(args.inviteId, next);
    return { invite: next, alreadyRevoked: false };
  }
}
