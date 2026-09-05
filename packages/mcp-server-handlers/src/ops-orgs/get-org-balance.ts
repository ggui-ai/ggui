/**
 * `ggui_ops_get_org_balance` — read the shared prepaid credit
 * balance of an org the caller belongs to.
 *
 * Authorization is ANY membership role — every member can see how
 * much shared credit there is to spend. Non-members get the uniform
 * `org_not_found` (no existence leak).
 *
 * Missing-balance contract: an org whose balance row has never been
 * written reads as zeros — the balance VALUE is the contract, not
 * the row's existence.
 *
 * Pure over the {@link OrgsSource} seam.
 */
import { z } from 'zod';
import { defineHandler, type HandlerContext } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type { OrgBalanceRecord, OrgsSource } from './types.js';

const inputSchema = {
  orgId: z
    .string()
    .min(1)
    .describe(
      'Target org — the caller must be a member (any role). Discover via `ggui_ops_list_orgs`.',
    ),
} as const;

const outputSchema = {
  orgId: z.string(),
  balanceCents: z.number().int(),
  lifetimeGrantedCents: z.number().int(),
  lifetimeSpentCents: z.number().int(),
  updatedAt: z.string(),
} as const;

export interface GetOrgBalanceDeps {
  readonly orgs: OrgsSource;
}

export function createGetOrgBalanceHandler(
  deps: GetOrgBalanceDeps,
) {
  return defineHandler({
    name: 'ggui_ops_get_org_balance',
    title: 'Get org balance',
    audience: ['ops'],
    description:
      "Read the shared prepaid credit balance of an org the caller belongs to (any membership role). Returns `{balanceCents, lifetimeGrantedCents, lifetimeSpentCents, updatedAt}`; an org with no spend history reads as zeros. Orgs the caller doesn't belong to answer `org_not_found`, uniform with a missing id.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<OrgBalanceRecord> {
      const ownerSub = resolveOwnerSub('ggui_ops_get_org_balance', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      return deps.orgs.getBalance({ ownerSub, orgId: parsed.orgId });
    },
  });
}
