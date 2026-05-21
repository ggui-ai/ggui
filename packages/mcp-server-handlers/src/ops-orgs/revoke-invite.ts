/**
 * `ggui_ops_revoke_invite` — invalidate a pending org invite so the
 * bearer-secret link in the recipient's email stops working.
 *
 * Sibling of the AppSync `revokeOrgInvite` mutation. The adapter:
 *   - Atomically flips `status` from `pending` → `revoked` via a CAS
 *     ConditionExpression so a racing accept throws a clear conflict
 *     instead of silently overwriting.
 *   - Rejects already-accepted invites (idempotency restricted to
 *     `pending` / `revoked`).
 *   - Enforces caller is owner/admin of the invite's org (else
 *     `OrgInviteAccessDeniedError`).
 *
 * Pure over the {@link OrgInvitesSource} seam.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type { OrgInviteRecord, OrgInvitesSource } from './types.js';

const inputSchema = {
  inviteId: z
    .string()
    .min(1)
    .describe(
      'Target invite — must belong to an org the caller can administer.',
    ),
} as const;

const outputSchema = {
  inviteId: z.string(),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  alreadyRevoked: z.boolean(),
} as const;

export interface RevokeInviteOutput {
  readonly inviteId: string;
  readonly status: 'pending' | 'accepted' | 'revoked' | 'expired';
  readonly alreadyRevoked: boolean;
}

export interface RevokeInviteDeps {
  readonly invites: OrgInvitesSource;
}

export function createRevokeInviteHandler(
  deps: RevokeInviteDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  RevokeInviteOutput
> {
  return {
    name: 'ggui_ops_revoke_invite',
    title: 'Revoke org invite',
    audience: ['ops'],
    description:
      "Invalidate a pending org invite — the bearer-secret link in the recipient's email stops working. CAS on `status = 'pending'` so a racing accept surfaces a conflict; idempotent for already-revoked invites; rejects already-accepted. Caller must be owner/admin of the invite's org.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<RevokeInviteOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_revoke_invite', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const result = await deps.invites.revoke({
        ownerSub,
        inviteId: parsed.inviteId,
      });
      const r: OrgInviteRecord = result.invite;
      return {
        inviteId: r.inviteId,
        status: r.status,
        alreadyRevoked: result.alreadyRevoked,
      };
    },
  };
}
