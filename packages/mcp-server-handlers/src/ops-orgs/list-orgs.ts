/**
 * `ggui_ops_list_orgs` — enumerate every `GguiOrg` the caller belongs
 * to (owner + admin + member memberships in one list, each tagged
 * with the caller's role).
 *
 * Sibling of the AppSync `fetchMyOrgs` custom resolver — same data,
 * MCP surface. Pure over the {@link OrgsSource} seam; the cloud pod
 * binds an AppSync-backed implementation, tests bind in-memory state.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type { OrgMembershipRecord, OrgsSource } from './types.js';

const inputSchema = {} satisfies Record<string, never>;

const outputSchema = {
  orgs: z.array(
    z.object({
      orgId: z.string(),
      name: z.string(),
      ownerUserId: z.string(),
      role: z.enum(['owner', 'admin', 'member']),
      joinedAt: z.string(),
    }),
  ),
} as const;

export interface ListOrgsOutput {
  readonly orgs: readonly OrgMembershipRecord[];
}

export interface ListOrgsDeps {
  readonly orgs: OrgsSource;
}

export function createListOrgsHandler(
  deps: ListOrgsDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, ListOrgsOutput> {
  return {
    name: 'ggui_ops_list_orgs',
    title: 'List orgs',
    audience: ['ops'],
    description:
      "Enumerate every org the calling user belongs to — owner + admin + member memberships in a single list, each row carrying the caller's role and the org's display name. Mirrors the console's `fetchMyOrgs` join. Use to discover orgIds before calling `ggui_ops_invite_to_org` / `ggui_ops_revoke_invite`.",
    inputSchema,
    outputSchema,
    async handler(
      _input: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<ListOrgsOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_list_orgs', ctx);
      const orgs = await deps.orgs.listMemberships(ownerSub);
      return { orgs };
    },
  };
}
