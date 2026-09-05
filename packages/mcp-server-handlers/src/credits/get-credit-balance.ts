/**
 * `ggui_get_credit_balance` — read the calling user's prepaid pool
 * balance.
 *
 * Lets Claude Desktop conversations like "what's my credit balance?"
 * resolve via the same data source the console reads.
 *
 * Pure I/O over the {@link CreditBalanceSource} seam — a cloud
 * deployment backs it with a real credit-balance datastore; tests
 * inject an in-memory fake.
 *
 * Identity scope: credit rows are keyed by USER identity, so the
 * handler reads `ctx.userId` when the host's auth layer resolves a
 * distinct per-user identity (multi-tenant hosts where `ctx.appId`
 * names the caller's active app, not the caller), and falls back to
 * `ctx.appId` for single-tenant hosts whose auth adapter folds the
 * user into the app slot (`appId = workspaceId ?? userId` — see
 * `packages/mcp-server/src/auth.ts#defaultAppIdFromIdentity`).
 * Reading `ctx.appId` alone silently returns the zero-row fallback
 * for every multi-tenant caller — an app id never keys a credit row.
 * The tool is registered on every deployment kind; callers without a
 * credit account (e.g. agent-builder identities) get the zero-row
 * fallback.
 */
import { z } from 'zod';
import { defineHandler } from '../types.js';

/**
 * Read-only seam for the credit-balance row. A cloud deployment
 * implements this directly against its credit datastore; tests use
 * an in-memory fake.
 *
 * Returns the full balance shape (not just balanceCents) so the
 * tool can surface lifetime granted/spent alongside the live
 * balance — Claude Desktop renders this as a single MCP-tool result.
 */
export interface CreditBalanceSource {
  /** Returns null when the balance row doesn't exist (pre-`grantFreeCreditOnce` state). */
  getBalance(userId: string): Promise<CreditBalanceView | null>;
}

export interface CreditBalanceView {
  readonly balanceCents: number;
  readonly lifetimeGrantedCents: number;
  readonly lifetimeSpentCents: number;
  readonly updatedAt: string;
}

export interface GetCreditBalanceDeps {
  /**
   * Required — the credit-balance source. Omitted = the handler
   * registers but throws at call time. Production deployments MUST
   * wire this; OSS deployments without a credit pool simply omit
   * the tool from the registered set instead of binding a no-op
   * source.
   */
  readonly creditBalance: CreditBalanceSource;
}

const inputSchema = {} satisfies Record<string, never>;

const outputSchema = {
  /** Live balance in cents — divide by 100 for dollars. */
  balanceCents: z.number().int(),
  /** Cumulative positive deltas (free + topup + refund). */
  lifetimeGrantedCents: z.number().int(),
  /** Cumulative absolute-value of charges. */
  lifetimeSpentCents: z.number().int(),
  /** ISO timestamp of the last balance write. */
  updatedAt: z.string(),
};

export interface GetCreditBalanceOutput {
  readonly balanceCents: number;
  readonly lifetimeGrantedCents: number;
  readonly lifetimeSpentCents: number;
  readonly updatedAt: string;
}

export function createGetCreditBalanceHandler(
  deps: GetCreditBalanceDeps,
) {
  return defineHandler({
    name: 'ggui_ops_get_credit_balance',
    title: 'Get credit balance',
    audience: ['ops'],
    description:
      "Returns the calling user's prepaid Anthropic-pool credit balance. Surfaces balanceCents (current spendable), lifetimeGrantedCents (total received including the $5 welcome credit), and lifetimeSpentCents (cumulative charges). For non-Anthropic providers, configure a BYOK key at console.ggui.ai/keys/providers — credit doesn't apply. Composing blueprints in Claude Desktop bypasses credits entirely.",
    inputSchema,
    outputSchema,
    // No `allowedFor` — same toolset on every pod kind. Callers
    // without a credit account get the zero-row fallback below; no
    // separate "tool not registered" UX needed.
    async handler(_input, ctx) {
      // USER identity first — on multi-tenant hosts `ctx.appId` is the
      // caller's active app, which never keys a credit row (see the
      // module docstring). Single-tenant hosts leave `ctx.userId`
      // unset and fold the user into the app slot.
      const userId = ctx.userId ?? ctx.appId;
      if (!userId) {
        throw new Error(
          'ggui_get_credit_balance: missing caller identity (ctx.userId and ctx.appId both unset)',
        );
      }
      const balance = await deps.creditBalance.getBalance(userId);
      if (!balance) {
        // Row missing — most likely the user signed in via API key
        // but never opened the console (which is what runs the
        // grantFreeCreditOnce mutation). Surface a zero-balance
        // shape rather than 404 so the tool result is uniform.
        return {
          balanceCents: 0,
          lifetimeGrantedCents: 0,
          lifetimeSpentCents: 0,
          updatedAt: new Date(0).toISOString(),
        };
      }
      return {
        balanceCents: balance.balanceCents,
        lifetimeGrantedCents: balance.lifetimeGrantedCents,
        lifetimeSpentCents: balance.lifetimeSpentCents,
        updatedAt: balance.updatedAt,
      };
    },
  });
}
