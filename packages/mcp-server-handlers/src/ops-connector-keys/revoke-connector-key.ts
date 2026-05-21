/**
 * `ggui_ops_revoke_connector_key` — soft-revoke a `GguiUserApiKey`
 * row.
 *
 * Adapter sets `status='revoked'`; the auth path rejects revoked keys
 * regardless of hash match. Rows are kept for audit (cleanup by
 * age-based sweep). Cross-user revocations throw
 * `ConnectorKeyAccessDeniedError`. Idempotent for already-revoked keys.
 *
 * Pure over the {@link ConnectorKeysSource} seam.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type {
  ConnectorKeySummary,
  ConnectorKeysSource,
} from './types.js';

const inputSchema = {
  keyId: z
    .string()
    .min(1)
    .describe(
      "Stable id of the `GguiUserApiKey` row (NOT the secret string). Discover via `ggui_ops_list_connector_keys`.",
    ),
} as const;

const outputSchema = {
  id: z.string(),
  status: z.enum(['active', 'revoked']),
  alreadyRevoked: z.boolean(),
} as const;

export interface RevokeConnectorKeyOutput {
  readonly id: string;
  readonly status: 'active' | 'revoked';
  readonly alreadyRevoked: boolean;
}

export interface RevokeConnectorKeyDeps {
  readonly connectorKeys: ConnectorKeysSource;
}

export function createRevokeConnectorKeyHandler(
  deps: RevokeConnectorKeyDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  RevokeConnectorKeyOutput
> {
  return {
    name: 'ggui_ops_revoke_connector_key',
    title: 'Revoke connector key',
    audience: ['ops'],
    description:
      "Soft-revoke a `ggui_user_*` connector key the caller owns. Adapter sets `status='revoked'`; the auth path rejects revoked keys regardless of hash match. Cross-user revocations throw `connector_key_access_denied`. Idempotent — re-revoking returns `alreadyRevoked: true`.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<RevokeConnectorKeyOutput> {
      const ownerSub = resolveOwnerSub(
        'ggui_ops_revoke_connector_key',
        ctx,
      );
      const parsed = z.object(inputSchema).parse(rawInput);
      const result = await deps.connectorKeys.revoke({
        ownerSub,
        keyId: parsed.keyId,
      });
      const s: ConnectorKeySummary = result.summary;
      return {
        id: s.id,
        status: s.status,
        alreadyRevoked: result.alreadyRevoked,
      };
    },
  };
}
