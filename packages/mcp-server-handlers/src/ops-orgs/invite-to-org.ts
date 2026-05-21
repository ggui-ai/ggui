/**
 * `ggui_ops_invite_to_org` — issue an `admin`- or `member`-role
 * invite to a `GguiOrg` the caller can administer.
 *
 * Sibling of the AppSync `issueOrgInvite` mutation
 * (`backend/amplify/data/issue-org-invite/`). The adapter enforces:
 *   - Caller is owner OR admin of the target org (else
 *     `OrgInviteAccessDeniedError`).
 *   - Anti-double-issue: existing `pending` invite for the same
 *     (orgId, email) is reused — `reused: true` in the result.
 *
 * Pure over the {@link OrgInvitesSource} seam.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type { OrgInviteRecord, OrgInvitesSource } from './types.js';

const inputSchema = {
  orgId: z
    .string()
    .min(1)
    .describe(
      'Target org — must be one the calling user owns or administers. Discover via `ggui_ops_list_orgs`.',
    ),
  email: z
    .string()
    .email()
    .describe('Recipient email — the invite link is sent here.'),
  role: z
    .enum(['admin', 'member'])
    .describe(
      "Role the recipient will hold once they accept. Owner role can't be granted via invite — ownership transfer is a separate flow.",
    ),
} as const;

const outputSchema = {
  inviteId: z.string(),
  orgId: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'member']),
  inviterUserId: z.string(),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  expiresAt: z.string(),
  createdAt: z.string(),
  reused: z.boolean(),
} as const;

export interface InviteToOrgOutput {
  readonly inviteId: string;
  readonly orgId: string;
  readonly email: string;
  readonly role: 'admin' | 'member';
  readonly inviterUserId: string;
  readonly status: 'pending' | 'accepted' | 'revoked' | 'expired';
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly reused: boolean;
}

export interface InviteToOrgDeps {
  readonly invites: OrgInvitesSource;
}

export function createInviteToOrgHandler(
  deps: InviteToOrgDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  InviteToOrgOutput
> {
  return {
    name: 'ggui_ops_invite_to_org',
    title: 'Invite to org',
    audience: ['ops'],
    description:
      "Issue an admin- or member-role invite to a `GguiOrg`. Caller must be owner/admin of the target org. Anti-double-issue: an existing pending invite for the same (orgId, email) is reused (no new row, no second email) and the result carries `reused: true`. The invite link in the email is `console.ggui.ai/invites/<inviteId>`.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<InviteToOrgOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_invite_to_org', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const result = await deps.invites.issue({
        ownerSub,
        orgId: parsed.orgId,
        email: parsed.email,
        role: parsed.role,
      });
      const r: OrgInviteRecord = result.invite;
      return {
        inviteId: r.inviteId,
        orgId: r.orgId,
        email: r.email,
        role: r.role,
        inviterUserId: r.inviterUserId,
        status: r.status,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        reused: result.reused,
      };
    },
  };
}
