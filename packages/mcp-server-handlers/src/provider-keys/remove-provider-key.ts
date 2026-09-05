/**
 * `ggui_ops_remove_provider_key` — remove a BYOK LLM provider key
 * from an MCP client. Idempotent: `deleted: false` reports "no row
 * to remove" (success — both states are user-success).
 *
 * Two scopes, one tool (mirrors `ggui_ops_set_provider_key`):
 *   - No `appId` (default): removes the caller's account-level key
 *     ({@link ProviderKeyStore}).
 *   - `appId` present: removes that app's key
 *     ({@link AppScopedProviderKeyStore}) — bound only where the
 *     deployment supports app-scoped keys; elsewhere the argument is
 *     rejected with `app_scoped_keys_unavailable`. The caller must
 *     own the target app; missing/foreign apps answer the uniform
 *     `app_not_found`.
 */
import { z } from 'zod';
import { defineHandler, type HandlerContext } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type {
  AppScopedProviderKeyStore,
  ProviderKeyStore,
} from './types.js';
import { AppScopedKeysUnavailableError, isProviderName } from './types.js';

const inputSchema = {
  provider: z
    .enum(['anthropic', 'openai', 'google', 'openrouter'])
    .describe('Which LLM provider key to remove.'),
  appId: z
    .string()
    .min(1)
    .describe(
      "Remove the key scoped to ONE app the caller owns instead of the account-level key. Only available on deployments that store per-app keys.",
    )
    .optional(),
} as const;

const outputSchema = {
  deleted: z
    .boolean()
    .describe(
      'True if a row existed and was deleted; false if no row matched. Both are success states.',
    ),
  provider: z.enum(['anthropic', 'openai', 'google', 'openrouter']),
} as const;

export interface RemoveProviderKeyDeps {
  readonly store: ProviderKeyStore;
  /**
   * Optional app-scope sibling — bind only where the deployment
   * stores per-app keys. Absent + `appId` supplied ⇒ typed
   * `app_scoped_keys_unavailable` rejection.
   */
  readonly appScopedStore?: AppScopedProviderKeyStore;
}

export function createRemoveProviderKeyHandler(
  deps: RemoveProviderKeyDeps,
) {
  return defineHandler({
    name: 'ggui_ops_remove_provider_key',
    title: 'Remove provider key',
    audience: ['ops'],
    description:
      "Remove the caller's BYOK LLM provider key for the given provider. Pass `appId` to remove the key scoped to one app the caller owns instead of the account-level key (requires a deployment with app-scoped key storage). Idempotent: `deleted: false` means no row was found (still success). Use to clear a key after rotation or before switching providers.",
    inputSchema,
    outputSchema,
    // No `allowedFor` — same toolset on every deployment kind. Removal is
    // identity-scoped by `ctx.appId`; idempotent regardless of whether
    // a row existed for the caller.
    async handler(rawInput: Record<string, unknown>, ctx: HandlerContext) {
      if (!ctx.appId) {
        throw new Error(
          'ggui_ops_remove_provider_key: missing caller identity (appId empty)',
        );
      }
      const parsed = z.object(inputSchema).parse(rawInput);
      if (!isProviderName(parsed.provider)) {
        throw new Error(`Invalid provider: ${String(parsed.provider)}`);
      }
      if (parsed.appId !== undefined) {
        if (!deps.appScopedStore) {
          throw new AppScopedKeysUnavailableError(
            'ggui_ops_remove_provider_key',
          );
        }
        // Ownership of the TARGET app is checked against the caller's
        // resolved sub (`ctx.userId` when the auth adapter produced
        // one) — `ctx.appId` alone may name an app, not a user.
        const ownerSub = resolveOwnerSub('ggui_ops_remove_provider_key', ctx);
        return deps.appScopedStore.remove({
          ownerSub,
          appId: parsed.appId,
          provider: parsed.provider,
        });
      }
      return deps.store.remove({
        userId: ctx.appId,
        provider: parsed.provider,
      });
    },
  });
}
