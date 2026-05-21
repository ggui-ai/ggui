/**
 * `ggui_ops_issue_connector_key` — mint a fresh `ggui_user_*` API key
 * for the calling user.
 *
 * Sibling of the AppSync `issueGguiUserApiKey` mutation
 * (`backend/amplify/data/issue-api-key/`). The adapter mints the
 * plaintext, persists `sha256(plaintext)` hex + apiKeyPrefix in DDB,
 * and returns the plaintext exactly ONCE in the result. Subsequent
 * `list_connector_keys` calls NEVER reveal it.
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
  name: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "Optional human-readable label, e.g. 'MacBook Claude Desktop'. Surfaces in `ggui_ops_list_connector_keys`.",
    ),
  appId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional `GguiApp.appId` to lock this key to. When set, sessions opened with this key scope to the named app and meta-tools (`ggui_open_app`, `ggui_ops_list_apps`) are NOT exposed. Absent ⇒ universal key — scopes to `User.defaultAppId` per request.",
    ),
  expiresAt: z
    .string()
    .datetime()
    .optional()
    .describe(
      'Optional ISO expiry timestamp. Past timestamps reject auth from the start.',
    ),
} as const;

const outputSchema = {
  /** Metadata for the new row — identical shape to `list_connector_keys`. */
  id: z.string(),
  apiKeyPrefix: z.string(),
  name: z.string().optional(),
  appId: z.string().optional(),
  status: z.enum(['active', 'revoked']),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  /**
   * The plaintext `ggui_user_*` secret. ONE-TIME REVEAL. Caller MUST
   * surface this to the user immediately for copy; we don't store it
   * anywhere a follow-up call can read.
   */
  plaintextKey: z.string(),
} as const;

export interface IssueConnectorKeyOutput {
  readonly id: string;
  readonly apiKeyPrefix: string;
  readonly name?: string;
  readonly appId?: string;
  readonly status: 'active' | 'revoked';
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
  readonly plaintextKey: string;
}

export interface IssueConnectorKeyDeps {
  readonly connectorKeys: ConnectorKeysSource;
}

export function createIssueConnectorKeyHandler(
  deps: IssueConnectorKeyDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  IssueConnectorKeyOutput
> {
  return {
    name: 'ggui_ops_issue_connector_key',
    title: 'Issue connector key',
    audience: ['ops'],
    description:
      "Mint a fresh `ggui_user_*` connector key. ONE-TIME REVEAL: the result carries the plaintext secret — surface it to the user immediately; subsequent list calls NEVER return it. Optional `name`, `appId` (lock the key to one app), `expiresAt`. The hash is stored, the plaintext is not.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<IssueConnectorKeyOutput> {
      const ownerSub = resolveOwnerSub(
        'ggui_ops_issue_connector_key',
        ctx,
      );
      const parsed = z.object(inputSchema).parse(rawInput);
      const result = await deps.connectorKeys.issue({
        ownerSub,
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.appId !== undefined ? { appId: parsed.appId } : {}),
        ...(parsed.expiresAt !== undefined
          ? { expiresAt: parsed.expiresAt }
          : {}),
      });
      const s: ConnectorKeySummary = result.summary;
      return {
        id: s.id,
        apiKeyPrefix: s.apiKeyPrefix,
        ...(s.name !== undefined ? { name: s.name } : {}),
        ...(s.appId !== undefined ? { appId: s.appId } : {}),
        status: s.status,
        createdAt: s.createdAt,
        ...(s.lastUsedAt !== undefined ? { lastUsedAt: s.lastUsedAt } : {}),
        ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
        plaintextKey: result.plaintextKey,
      };
    },
  };
}
