/**
 * `ggui_set_provider_key` — set a BYOK LLM provider key from an MCP
 * client. Sibling to the `setGguiUserProviderKey` AppSync mutation
 * (S2.2); same validation + KMS encrypt + DDB upsert path,
 * different surface (Claude Desktop conversation vs. console UI).
 *
 * Pure over the {@link ProviderKeyStore} seam — the implementation
 * (pod-side, AWS-backed) lives elsewhere; this factory just wires
 * the MCP tool shape.
 *
 * The plaintext key crosses the wire ONCE — from the MCP client
 * (Claude Desktop) into this handler, into the store's `set` call,
 * which validates + encrypts + persists. The result NEVER carries
 * plaintext (curated `ProviderKeySummary` shape).
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import type { ProviderKeyStore, ProviderKeySummary } from './types.js';
import { isProviderName } from './types.js';

const inputSchema = {
  provider: z
    .enum(['anthropic', 'openai', 'google', 'openrouter'])
    .describe('Which LLM provider this key belongs to.'),
  plaintextKey: z
    .string()
    .min(1)
    .describe(
      'The raw API key string. Validated against the provider before persistence; the plaintext is then KMS-encrypted and the plaintext is never persisted nor returned.',
    ),
  label: z
    .string()
    .optional()
    .describe(
      "Optional human-readable label, e.g. 'personal anthropic'. Surfaces in the console + ggui_list_provider_keys.",
    ),
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
}

export function createSetProviderKeyHandler(
  deps: SetProviderKeyDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, ProviderKeySummary> {
  return {
    name: 'ggui_ops_set_provider_key',
    title: 'Set provider key',
    audience: ['ops'],
    description:
      "Set the caller's BYOK LLM provider key. Validates against the provider's verify endpoint, KMS-encrypts the plaintext, and persists the row. Re-set replaces an existing row (rotation). Returns metadata only — provider, optional label, last 4 chars, createdAt — NEVER plaintext, NEVER the encrypted blob. Use this to set the user's key from a Claude Desktop conversation without opening the console.",
    inputSchema,
    outputSchema,
    // No `allowedFor` — same toolset on every pod kind. The store
    // scopes writes to the caller's resolved identity (`ctx.appId`);
    // BYOK availability is a per-deployment config (the pod's
    // `providerKeyStore` singleton stubs out when env vars unset).
    async handler(rawInput: Record<string, unknown>, ctx: HandlerContext) {
      if (!ctx.appId) {
        throw new Error(
          'ggui_set_provider_key: missing caller identity (appId empty)',
        );
      }
      const parsed = z.object(inputSchema).parse(rawInput);
      // The schema's z.enum already narrows; isProviderName is the
      // belt-and-suspenders check for the runtime-input boundary.
      if (!isProviderName(parsed.provider)) {
        throw new Error(`Invalid provider: ${String(parsed.provider)}`);
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
