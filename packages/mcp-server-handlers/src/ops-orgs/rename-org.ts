/**
 * `ggui_ops_rename_org` — update an org's display name.
 *
 * Authorization is owner-OR-admin (deliberately wider than
 * creator-only: an admin curates the org's presentation just like the
 * owner does). The adapter enforces the role gate; member-role
 * callers get `org_access_denied`, non-members get the uniform
 * `org_not_found` (no existence leak).
 *
 * Validation: name trimmed, non-empty, ≤120 chars — the same
 * constraint the org-provisioning path enforces.
 *
 * Pure over the {@link OrgsSource} seam.
 */
import { z } from 'zod';
import { defineHandler, type HandlerContext } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type { OrgsSource } from './types.js';

const inputSchema = {
  orgId: z
    .string()
    .min(1)
    .describe(
      'Target org — must be one the calling user owns or administers. Discover via `ggui_ops_list_orgs`.',
    ),
  name: z
    .string()
    .min(1)
    .max(120)
    .describe('New display name. Trimmed; cap 120 chars.'),
} as const;

const outputSchema = {
  orgId: z.string(),
  name: z.string(),
  updatedAt: z.string(),
} as const;

export interface RenameOrgOutput {
  readonly orgId: string;
  readonly name: string;
  readonly updatedAt: string;
}

export interface RenameOrgDeps {
  readonly orgs: OrgsSource;
}

export function createRenameOrgHandler(
  deps: RenameOrgDeps,
) {
  return defineHandler({
    name: 'ggui_ops_rename_org',
    title: 'Rename org',
    audience: ['ops'],
    description:
      "Rename an org the caller owns or administers (owner OR admin role — member-role callers are rejected with `org_access_denied`). Orgs the caller doesn't belong to answer `org_not_found`, uniform with a missing id. Cap 120 chars on the new name. Returns the updated row.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<RenameOrgOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_rename_org', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const renamed = await deps.orgs.rename({
        ownerSub,
        orgId: parsed.orgId,
        name: parsed.name,
      });
      return {
        orgId: renamed.orgId,
        name: renamed.name,
        updatedAt: renamed.updatedAt,
      };
    },
  });
}
