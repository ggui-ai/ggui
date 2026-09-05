/**
 * `ggui_list_credit_transactions` — read the calling user's
 * append-only credit ledger, newest-first.
 *
 * Lets Claude Desktop conversations like "show me my last 10
 * charges" resolve via the same data source the console reads.
 *
 * Pure I/O over the {@link CreditTransactionSource} seam — a cloud
 * deployment backs it with a real ledger datastore (composite
 * `(userId, transactionId)` key, newest-first sort); tests inject an
 * in-memory fake.
 *
 * Identity scope mirrors get-credit-balance: `ctx.userId` when the
 * host resolves a distinct per-user identity, else `ctx.appId` (the
 * single-app fold) — see that module's docstring for why reading
 * `ctx.appId` alone loses every multi-app caller.
 */
import { z } from 'zod';
import { defineHandler } from '../types.js';

/**
 * Read-only seam for the credit-transaction ledger. A production deployment
 * implements this against its own ledger store; tests use in-memory
 * state.
 */
export interface CreditTransactionSource {
  list(args: {
    userId: string;
    /** Capped at 100 by the handler. */
    limit: number;
    /** Opaque cursor — ULID `transactionId` from a previous page's last row. */
    cursor?: string;
  }): Promise<{
    transactions: CreditTransactionView[];
    /** Set when more rows exist past `limit`. */
    nextCursor?: string;
  }>;
}

export interface CreditTransactionView {
  readonly transactionId: string;
  readonly kind: 'free_credit' | 'render_charge' | 'topup' | 'refund';
  readonly deltaCents: number;
  readonly balanceAfterCents: number;
  readonly reason: string;
  readonly createdAt: string;
  readonly relatedSessionId?: string;
}

export interface ListCreditTransactionsDeps {
  readonly creditTransactions: CreditTransactionSource;
}

const inputSchema = {
  /** Default 20. Cap 100. */
  limit: z.number().int().min(1).max(100).optional(),
  /** Opaque pagination cursor returned in the previous response. */
  cursor: z.string().optional(),
};

const outputSchema = {
  transactions: z.array(
    z.object({
      transactionId: z.string(),
      kind: z.enum(['free_credit', 'render_charge', 'topup', 'refund']),
      deltaCents: z.number().int(),
      balanceAfterCents: z.number().int(),
      reason: z.string(),
      createdAt: z.string(),
      relatedSessionId: z.string().optional(),
    }),
  ),
  /** Set when more rows exist past `limit`. Pass back as the next call's `cursor`. */
  nextCursor: z.string().optional(),
};

export interface ListCreditTransactionsOutput {
  readonly transactions: CreditTransactionView[];
  readonly nextCursor?: string;
}

export function createListCreditTransactionsHandler(
  deps: ListCreditTransactionsDeps,
) {
  return defineHandler({
    name: 'ggui_ops_list_credit_transactions',
    title: 'List credit transactions',
    audience: ['ops'],
    description:
      "Returns the calling user's credit transaction ledger, newest-first. Each row carries kind ('free_credit' | 'render_charge' | 'topup' | 'refund'), deltaCents (signed — positive for grants/topups, negative for charges), balanceAfterCents (snapshot at time of write), reason (human-readable), and optional relatedSessionId for render_charge rows. Default limit 20, cap 100; pass `cursor` from the previous response's `nextCursor` for paging.",
    inputSchema,
    outputSchema,
    // No `allowedFor` — same toolset on every deployment kind. Callers
    // without a credit account see an empty ledger.
    async handler(rawInput, ctx) {
      // USER identity first — `ctx.appId` is the active app on
      // multi-app hosts and never keys a ledger row (see
      // get-credit-balance's module docstring).
      const userId = ctx.userId ?? ctx.appId;
      if (!userId) {
        throw new Error(
          'ggui_list_credit_transactions: missing caller identity (ctx.userId and ctx.appId both unset)',
        );
      }
      const parsed = z.object(inputSchema).parse(rawInput);
      const limit = parsed.limit ?? 20;
      const cursor = parsed.cursor;
      const result = await deps.creditTransactions.list({
        userId,
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return {
        transactions: result.transactions,
        ...(result.nextCursor !== undefined
          ? { nextCursor: result.nextCursor }
          : {}),
      };
    },
  });
}
