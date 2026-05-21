/**
 * `ggui_ops_list_connector_keys` — read the calling user's
 * `GguiUserApiKey` rows (metadata only, NEVER plaintext).
 *
 * Sibling of the console's Connector Keys section + the `/v1/keys`
 * Lambda. Pure over the {@link ConnectorKeysSource} seam.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type {
  ConnectorKeySummary,
  ConnectorKeysSource,
} from './types.js';

const inputSchema = {} satisfies Record<string, never>;

const outputSchema = {
  keys: z.array(
    z.object({
      id: z.string(),
      apiKeyPrefix: z.string(),
      name: z.string().optional(),
      appId: z.string().optional(),
      status: z.enum(['active', 'revoked']),
      createdAt: z.string(),
      lastUsedAt: z.string().optional(),
      expiresAt: z.string().optional(),
    }),
  ),
} as const;

export interface ListConnectorKeysOutput {
  readonly keys: readonly ConnectorKeySummary[];
}

export interface ListConnectorKeysDeps {
  readonly connectorKeys: ConnectorKeysSource;
}

export function createListConnectorKeysHandler(
  deps: ListConnectorKeysDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  ListConnectorKeysOutput
> {
  return {
    name: 'ggui_ops_list_connector_keys',
    title: 'List connector keys',
    audience: ['ops'],
    description:
      "Enumerate the calling user's `ggui_user_*` connector keys. Returns metadata only — id, first ~8 chars of the secret (`apiKeyPrefix` for human re-identification), name, optional bound appId, status (`active`/`revoked`), createdAt, lastUsedAt, optional expiresAt. NEVER returns plaintext or the hash.",
    inputSchema,
    outputSchema,
    async handler(
      _input: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<ListConnectorKeysOutput> {
      const ownerSub = resolveOwnerSub(
        'ggui_ops_list_connector_keys',
        ctx,
      );
      const keys = await deps.connectorKeys.list(ownerSub);
      return { keys };
    },
  };
}
