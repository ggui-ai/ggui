/**
 * `ggui_ops_set_provider_key` — set a BYOK LLM provider key from an
 * MCP client. Same validation + encrypt + persist path as the
 * account UI, different surface (MCP conversation vs. console UI).
 *
 * Two scopes, one tool:
 *   - No `appId` (default): the key applies to the caller's whole
 *     account ({@link ProviderKeyStore}).
 *   - `appId` present: the key applies to that single app
 *     ({@link AppScopedProviderKeyStore}) — bound only where the
 *     deployment supports app-scoped keys; elsewhere the argument is
 *     rejected with `app_scoped_keys_unavailable`. The caller must
 *     own the target app; missing/foreign apps answer the uniform
 *     `app_not_found`.
 *
 * The plaintext key crosses the wire ONCE — from the MCP client
 * into this handler, into the store's `set` call, which validates +
 * encrypts + persists. The result NEVER carries plaintext (curated
 * `ProviderKeySummary` shape).
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type {
  AppScopedProviderKeyStore,
  ProviderKeyStore,
  ProviderKeySummary,
} from './types.js';
import { AppScopedKeysUnavailableError, isProviderName } from './types.js';

const inputSchema = {
  provider: z
    .enum(['anthropic', 'openai', 'google', 'openrouter'])
    .describe('Which LLM provider this key belongs to.'),
  plaintextKey: z
    .string()
    .min(1)
    .describe(
      'The raw API key string. Validated against the provider before persistence; the plaintext is then encrypted at rest and never persisted nor returned.',
    ),
  label: z
    .string()
    .optional()
    .describe(
      "Optional human-readable label, e.g. 'personal anthropic'. Surfaces in ggui_ops_list_provider_keys.",
    ),
  appId: z
    .string()
    .min(1)
    .describe(
      'Scope the key to ONE app the caller owns instead of the whole account. App-scoped keys take precedence over the account key when that app renders. Only available on deployments that store per-app keys.',
    )
    .optional(),
} as const;

const outputSchema = {
  provider: z.enum(['anthropic', 'openai', 'google', 'openrouter']),
  label: z.string().optional(),
  lastFour: z.string(),
  createdAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
} as const;

export interface SetProviderKeyDeps {
  readonly store: ProviderKeyStore;
  /**
   * Optional app-scope sibling — bind only where the deployment
   * stores per-app keys. Absent + `appId` supplied ⇒ typed
   * `app_scoped_keys_unavailable` rejection.
   */
  readonly appScopedStore?: AppScopedProviderKeyStore;
}

export function createSetProviderKeyHandler(
  deps: SetProviderKeyDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, ProviderKeySummary> {
  return {
    name: 'ggui_ops_set_provider_key',
    title: 'Set provider key',
    audience: ['ops'],
    description:
      "Set the caller's BYOK LLM provider key. Validates against the provider's verify endpoint, encrypts the plaintext at rest, and persists the row. Re-set replaces an existing row (rotation). Pass `appId` to scope the key to one app the caller owns instead of the whole account (app key beats account key for that app's renders; requires a deployment with app-scoped key storage). Returns metadata only — provider, optional label, last 4 chars, createdAt — NEVER plaintext, NEVER the encrypted blob.",
    inputSchema,
    outputSchema,
    // No `allowedFor` — same toolset on every deployment kind. The store
    // scopes writes to the caller's resolved identity (`ctx.appId`);
    // BYOK availability is a per-deployment config.
    async handler(rawInput: Record<string, unknown>, ctx: HandlerContext) {
      if (!ctx.appId) {
        throw new Error(
          'ggui_ops_set_provider_key: missing caller identity (appId empty)',
        );
      }
      const parsed = z.object(inputSchema).parse(rawInput);
      // The schema's z.enum already narrows; isProviderName is the
      // belt-and-suspenders check for the runtime-input boundary.
      if (!isProviderName(parsed.provider)) {
        throw new Error(`Invalid provider: ${String(parsed.provider)}`);
      }
      if (parsed.appId !== undefined) {
        if (!deps.appScopedStore) {
          throw new AppScopedKeysUnavailableError('ggui_ops_set_provider_key');
        }
        // Ownership of the TARGET app is checked against the caller's
        // resolved sub (`ctx.userId` when the auth adapter produced
        // one) — `ctx.appId` alone may name an app, not a user.
        const ownerSub = resolveOwnerSub('ggui_ops_set_provider_key', ctx);
        return deps.appScopedStore.set({
          ownerSub,
          appId: parsed.appId,
          provider: parsed.provider,
          plaintextKey: parsed.plaintextKey,
          ...(parsed.label !== undefined ? { label: parsed.label } : {}),
        });
      }
      return deps.store.set({
        userId: ctx.appId,
        provider: parsed.provider,
        plaintextKey: parsed.plaintextKey,
        label: parsed.label,
      });
    },
  };
}
