/**
 * `ggui_ops_remove_org_member` — remove a member from an org, OR
 * leave an org voluntarily (removing yourself).
 *
 * Permission matrix (caller's role × target's role), enforced by the
 * adapter:
 *
 *                target=owner   target=admin   target=member
 *   caller=owner    no             yes            yes
 *   caller=admin    no             only-self      yes
 *   caller=member   no             no             only-self
 *
 * The org owner can never be removed — ownership transfer is a
 * separate flow. Matrix violations throw
 * `org_member_removal_denied` naming the specific rule; non-member
 * callers get the uniform `org_not_found` (no existence leak).
 *
 * Idempotent: removing an already-absent member returns
 * `alreadyAbsent: true` rather than throwing — the target row
 * disappears even if a parallel removal got there first.
 *
 * Pure over the {@link OrgsSource} seam.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type { OrgsSource } from './types.js';

const inputSchema = {
  orgId: z
    .string()
    .min(1)
    .describe(
      'Target org — the caller must be a member. Discover via `ggui_ops_list_orgs`.',
    ),
  memberUserId: z
    .string()
    .min(1)
    .describe(
      "The member's user id to remove. Pass your own user id to leave the org.",
    ),
} as const;

const outputSchema = {
  orgId: z.string(),
  memberUserId: z.string(),
  alreadyAbsent: z
    .boolean()
    .describe(
      'True when no membership row existed (already removed, or never a member). Both outcomes are success.',
    ),
} as const;

export interface RemoveOrgMemberOutput {
  readonly orgId: string;
  readonly memberUserId: string;
  readonly alreadyAbsent: boolean;
}

export interface RemoveOrgMemberDeps {
  readonly orgs: OrgsSource;
}

export function createRemoveOrgMemberHandler(
  deps: RemoveOrgMemberDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  RemoveOrgMemberOutput
> {
  return {
    name: 'ggui_ops_remove_org_member',
    title: 'Remove org member',
    audience: ['ops'],
    description:
      "Remove a member from an org, or leave an org by removing yourself. Role matrix: owners remove any non-owner; admins remove members (and themselves); members remove only themselves. The org OWNER can never be removed — transfer ownership first. Matrix violations throw `org_member_removal_denied` with the specific rule; orgs the caller doesn't belong to answer `org_not_found`. Idempotent: an already-absent target returns `alreadyAbsent: true`.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<RemoveOrgMemberOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_remove_org_member', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const result = await deps.orgs.removeMember({
        ownerSub,
        orgId: parsed.orgId,
        memberUserId: parsed.memberUserId,
      });
      return {
        orgId: result.orgId,
        memberUserId: result.memberUserId,
        alreadyAbsent: result.alreadyAbsent,
      };
    },
  };
}
