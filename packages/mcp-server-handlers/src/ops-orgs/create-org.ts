/**
 * `ggui_ops_create_org` — provision a fresh `GguiOrg` with the caller
 * as owner.
 *
 * Sibling of the AppSync `provisionGguiOrg` mutation
 * (`backend/amplify/data/create-org/`). Same identity gate (caller's
 * sub from `event.identity.sub`), same atomic TransactWrite (org row
 * + owner membership row + zero-balance credit row at the adapter
 * layer). MCP surface lets an LLM agent in the console create an org
 * without a custom GraphQL call.
 *
 * Pure over the {@link OrgsSource} seam.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type { OrgRecord, OrgsSource } from './types.js';

const inputSchema = {
  name: z
    .string()
    .min(1)
    .max(120)
    .describe(
      'Human-friendly org display name. Required (no default — orgs are intentional creations).',
    ),
} as const;

const outputSchema = {
  orgId: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
} as const;

export interface CreateOrgOutput {
  readonly orgId: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateOrgDeps {
  readonly orgs: OrgsSource;
}

export function createCreateOrgHandler(
  deps: CreateOrgDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, CreateOrgOutput> {
  return {
    name: 'ggui_ops_create_org',
    title: 'Create org',
    audience: ['ops'],
    description:
      "Provision a fresh `GguiOrg` owned by the calling user. Wraps the cloud's `provisionGguiOrg` mutation: ULID orgId is minted server-side, the row is owned by the caller's Cognito sub, an owner membership row + zero-balance credit row are inserted atomically. Returns the persisted shape.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<CreateOrgOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_create_org', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const row: OrgRecord = await deps.orgs.create({
        ownerSub,
        name: parsed.name,
      });
      return {
        orgId: row.orgId,
        name: row.name,
        ownerUserId: row.ownerUserId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },
  };
}
