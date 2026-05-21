/**
 * `ggui_remove_provider_key` — remove a BYOK LLM provider key from
 * an MCP client. Sibling to `removeGguiUserProviderKey` AppSync
 * mutation (S2.2). Idempotent: `deleted: false` reports "no row to
 * remove" (success — both states are user-success).
 *
 * Pure over the {@link ProviderKeyStore} seam.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import type { ProviderKeyStore, RemoveResult } from './types.js';
import { isProviderName } from './types.js';

const inputSchema = {
  provider: z
    .enum(['anthropic', 'openai', 'google', 'openrouter'])
    .describe('Which LLM provider key to remove.'),
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
}

export function createRemoveProviderKeyHandler(
  deps: RemoveProviderKeyDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, RemoveResult> {
  return {
    name: 'ggui_ops_remove_provider_key',
    title: 'Remove provider key',
    audience: ['ops'],
    description:
      "Remove the caller's BYOK LLM provider key for the given provider. Idempotent: `deleted: false` means no row was found (still success). Use to clear a key after rotation or before switching providers.",
    inputSchema,
    outputSchema,
    // No `allowedFor` — same toolset on every pod kind. Removal is
    // identity-scoped by `ctx.appId`; idempotent regardless of whether
    // a row existed for the caller.
    async handler(rawInput: Record<string, unknown>, ctx: HandlerContext) {
      if (!ctx.appId) {
        throw new Error(
          'ggui_remove_provider_key: missing caller identity (appId empty)',
        );
      }
      const parsed = z.object(inputSchema).parse(rawInput);
      if (!isProviderName(parsed.provider)) {
        throw new Error(`Invalid provider: ${String(parsed.provider)}`);
      }
      return deps.store.remove({
        userId: ctx.appId,
        provider: parsed.provider,
      });
    },
  };
}
