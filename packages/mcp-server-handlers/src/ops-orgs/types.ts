/**
 * Seam types for the `ops-orgs` MCP tool family. Mirrors the
 * data-model rows that back the console's Orgs surface (the
 * `GguiOrg`, `GguiOrgMember`, and `GguiOrgInvite` records). Pure
 * over `@ggui-ai/protocol` shapes — NO AWS / database imports. Cloud
 * deployments bind an AWS-backed implementation; tests bind
 * in-memory fakes.
 */

/** Membership role on a single org. Mirrors the enum on `GguiOrgMember.role`. */
export type OrgRole = 'owner' | 'admin' | 'member';

/**
 * One row in the `GguiOrg` table, projected for MCP-tool readers.
 * Pure data — no relations, no Amplify-internal fields.
 */
export interface OrgRecord {
  /** ULID — primary key. */
  readonly orgId: string;
  /** User-editable display name. */
  readonly name: string;
  /** Original creator's Cognito sub. */
  readonly ownerUserId: string;
  /** ISO timestamp. */
  readonly createdAt: string;
  /** ISO timestamp; bumped on every write. */
  readonly updatedAt: string;
}

/**
 * Membership row returned from `OrgsSource.listMemberships`. Mirrors
 * the `FetchMyOrgsItem` AppSync custom type — one row per `(org ×
 * caller-membership)` pair so a consumer doesn't need a second
 * GraphQL call to render "your orgs + your role in each."
 */
export interface OrgMembershipRecord {
  readonly orgId: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly role: OrgRole;
  readonly joinedAt: string;
}

/**
 * Pending-invite shape returned by `issue` + `list`. Persistent state
 * mirrors the `GguiOrgInvite` model.
 */
export interface OrgInviteRecord {
  readonly inviteId: string;
  readonly orgId: string;
  readonly email: string;
  readonly role: 'admin' | 'member';
  readonly inviterUserId: string;
  readonly status: 'pending' | 'accepted' | 'revoked' | 'expired';
  readonly expiresAt: string;
  readonly createdAt: string;
}

/**
 * Read+write seam for `GguiOrg`. The cloud pod implements this against
 * AppSync (`provisionGguiOrg` mutation + `fetchMyOrgs` query); tests
 * implement it against in-memory state.
 *
 * Invariants:
 *   - `listMemberships(ownerSub)` returns every org the caller belongs
 *     to (owner + admin + member). Cross-user listings are impossible.
 *   - `create({ ownerSub, name })` mints a fresh orgId server-side
 *     (ULID for cloud; any unique string for tests). NEVER honors
 *     argument-supplied orgIds.
 */
export interface OrgsSource {
  /** Return every org the caller belongs to, with the caller's role. */
  listMemberships(
    ownerSub: string,
  ): Promise<readonly OrgMembershipRecord[]>;
  /** Provision a fresh org owned by the caller. */
  create(args: { ownerSub: string; name: string }): Promise<OrgRecord>;
}

/**
 * Read+write seam for `GguiOrgInvite`. Same posture as `OrgsSource` —
 * cloud binds `issueOrgInvite` + `revokeOrgInvite` AppSync mutations,
 * tests use in-memory state.
 *
 * Invariants:
 *   - `issue` enforces the caller is owner/admin of the org. Members
 *     get rejected with `OrgInviteAccessDeniedError`.
 *   - `revoke` enforces the caller is owner/admin of the org that
 *     owns the invite. Cross-tenant revocations are rejected with
 *     `OrgInviteAccessDeniedError`.
 *   - Both methods anti-double-issue: re-issuing for an existing
 *     `(orgId, email)` pending invite returns the existing row with
 *     `reused: true`.
 */
export interface OrgInvitesSource {
  issue(args: {
    ownerSub: string;
    orgId: string;
    email: string;
    role: 'admin' | 'member';
  }): Promise<{ invite: OrgInviteRecord; reused: boolean }>;
  revoke(args: {
    ownerSub: string;
    inviteId: string;
  }): Promise<{ invite: OrgInviteRecord; alreadyRevoked: boolean }>;
}

export class OrgInviteAccessDeniedError extends Error {
  readonly code = 'org_invite_access_denied' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OrgInviteAccessDeniedError';
  }
}

export class OrgInviteNotFoundError extends Error {
  readonly code = 'org_invite_not_found' as const;
  constructor(inviteId: string) {
    super(
      `org_invite_not_found: no invite ${JSON.stringify(inviteId)} reachable by the caller`,
    );
    this.name = 'OrgInviteNotFoundError';
  }
}
