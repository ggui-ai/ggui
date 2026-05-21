/**
 * `ggui_list_provider_keys` — read the caller's BYOK provider key
 * metadata. NEVER returns plaintext, NEVER returns the encrypted
 * blob.
 *
 * Pure over the {@link ProviderKeyStore} seam — no AWS imports.
 * Hosted pod binds an AWS-backed implementation; tests bind
 * in-memory fakes.
 *
 * Identity: caller's userId comes from `ctx.appId` (the upstream
 * auth adapter populates it from the resolved `Identity`). Tool is
 * registered on every pod kind; the handler refuses to run if the
 * appId is empty — that means an unauthenticated caller slipped past
 * auth, which would be a real bug worth surfacing.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import type { ProviderKeyStore, ProviderKeySummary } from './types.js';

const inputSchema = {} as const;

const outputSchema = {
  keys: z.array(
    z.object({
      provider: z.enum(['anthropic', 'openai', 'google', 'openrouter']),
      label: z.string().optional(),
      lastFour: z.string(),
      createdAt: z.string().optional(),
      lastUsedAt: z.string().optional(),
    }),
  ),
} as const;

export interface ListProviderKeysOutput {
  keys: readonly ProviderKeySummary[];
}

export interface ListProviderKeysDeps {
  readonly store: ProviderKeyStore;
}

export function createListProviderKeysHandler(
  deps: ListProviderKeysDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, ListProviderKeysOutput> {
  return {
    name: 'ggui_ops_list_provider_keys',
    title: 'List provider keys',
    audience: ['ops'],
    description:
      "List the caller's configured BYOK LLM provider keys. Returns metadata only — provider, optional label, last 4 chars (for re-identification), createdAt, lastUsedAt. NEVER returns plaintext or the encrypted blob. Use to check 'do I already have an Anthropic key set?' before prompting for one.",
    inputSchema,
    outputSchema,
    // No `allowedFor` — same toolset on every pod kind. Listing is
    // identity-scoped by `ctx.appId`; agent-builder identities just
    // see an empty list (they don't register BYOK keys).
    async handler(_input: Record<string, unknown>, ctx: HandlerContext) {
      if (!ctx.appId) {
        throw new Error(
          'ggui_list_provider_keys: missing caller identity (appId empty)',
        );
      }
      const keys = await deps.store.list(ctx.appId);
      return { keys };
    },
  };
}
