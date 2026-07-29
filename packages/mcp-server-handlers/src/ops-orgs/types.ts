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
 * Prepaid credit balance of an org's shared wallet. Every member may
 * read it (role does not gate visibility of the shared pool). A
 * balance row that has never been written reads as zeros — the
 * balance value is the contract, not the row's existence.
 */
export interface OrgBalanceRecord {
  readonly orgId: string;
  readonly balanceCents: number;
  readonly lifetimeGrantedCents: number;
  readonly lifetimeSpentCents: number;
  readonly updatedAt: string;
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
 * Read+write seam for `GguiOrg` (+ its membership + balance rows).
 * Cloud deployments bind a datastore-backed implementation; tests
 * implement it against in-memory state.
 *
 * Invariants:
 *   - `listMemberships(ownerSub)` returns every org the caller belongs
 *     to (owner + admin + member). Cross-user listings are impossible.
 *   - `create({ ownerSub, name })` mints a fresh orgId server-side
 *     (ULID for cloud; any unique string for tests). NEVER honors
 *     argument-supplied orgIds.
 *   - `rename` requires the caller to be owner OR admin of the org.
 *     Non-members get `OrgNotFoundError` (uniform with a missing
 *     orgId — no existence leak); member-role callers get
 *     `OrgAccessDeniedError` (they can already see the org exists).
 *   - `removeMember` enforces the role matrix (see
 *     {@link OrgsSource.removeMember}); non-member callers get the
 *     uniform `OrgNotFoundError`.
 *   - `getBalance` requires ANY membership; non-members get the
 *     uniform `OrgNotFoundError`. A missing balance row reads as
 *     zeros, never as an error.
 */
export interface OrgsSource {
  /** Return every org the caller belongs to, with the caller's role. */
  listMemberships(
    ownerSub: string,
  ): Promise<readonly OrgMembershipRecord[]>;
  /** Provision a fresh org owned by the caller. */
  create(args: { ownerSub: string; name: string }): Promise<OrgRecord>;
  /**
   * Rename the org. Caller must be owner or admin. The name is
   * trimmed and capped at 120 chars by the implementation.
   */
  rename(args: {
    ownerSub: string;
    orgId: string;
    name: string;
  }): Promise<{ orgId: string; name: string; updatedAt: string }>;
  /**
   * Remove a member row. Role matrix (caller's role × target's role):
   *
   *                 target=owner   target=admin   target=member
   *   caller=owner     no             yes            yes
   *   caller=admin     no             only-self      yes
   *   caller=member    no             no             only-self
   *
   * The org owner can never be removed (`OrgMemberRemovalDeniedError`
   * — ownership transfer is a separate flow); other matrix violations
   * throw the same error class with the specific rule in the message.
   * Removing an already-absent member resolves with
   * `alreadyAbsent: true` (idempotent — a parallel removal is not an
   * error).
   */
  removeMember(args: {
    ownerSub: string;
    orgId: string;
    memberUserId: string;
  }): Promise<{ orgId: string; memberUserId: string; alreadyAbsent: boolean }>;
  /** Read the org's shared credit balance. Any membership role. */
  getBalance(args: {
    ownerSub: string;
    orgId: string;
  }): Promise<OrgBalanceRecord>;
}

/**
 * Read+write seam for `GguiOrgInvite`. Same posture as `OrgsSource` —
 * cloud binds the invite mutations, tests use in-memory state.
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

/**
 * Uniform "not found" for org targets the caller cannot see — thrown
 * both for genuinely missing orgIds and for orgs the caller is not a
 * member of, so a probe can't learn whether an orgId exists.
 */
export class OrgNotFoundError extends Error {
  readonly code = 'org_not_found' as const;
  constructor(orgId: string) {
    super(
      `org_not_found: no org ${JSON.stringify(orgId)} reachable by the caller`,
    );
    this.name = 'OrgNotFoundError';
  }
}

/**
 * Thrown when a MEMBER of the org lacks the role an operation needs
 * (e.g. member-role caller renaming the org). Distinct from
 * {@link OrgNotFoundError}: members already know the org exists, so
 * naming the missing role is not an existence leak.
 */
export class OrgAccessDeniedError extends Error {
  readonly code = 'org_access_denied' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OrgAccessDeniedError';
  }
}

/**
 * Thrown when the member-removal role matrix denies the operation.
 * The message names the specific rule that was hit (owner removal,
 * admin-on-admin, member-on-other) so callers can surface it — the
 * caller is a verified member, so specificity leaks nothing.
 */
export class OrgMemberRemovalDeniedError extends Error {
  readonly code = 'org_member_removal_denied' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OrgMemberRemovalDeniedError';
  }
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
