/**
 * `ggui_ops_list_credit_transactions`: a ledger entry's `kind` is an OPEN
 * vocabulary (ggui#1532). A deployment's ledger may carry kinds this package
 * does not name, and the tool must hand each one through as it is, never refuse
 * the listing over it and never relabel it as a render charge.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  KNOWN_CREDIT_TRANSACTION_KINDS,
  createListCreditTransactionsHandler,
  type CreditTransactionView,
} from './list-credit-transactions.js';

const row = (kind: string): CreditTransactionView => ({
  transactionId: `01J${kind.length}`,
  kind,
  deltaCents: -5,
  balanceAfterCents: 95,
  reason: 'test',
  createdAt: '2026-09-30T00:00:00.000Z',
});

function handlerOver(rows: CreditTransactionView[]) {
  return createListCreditTransactionsHandler({
    creditTransactions: { list: async () => ({ transactions: rows }) },
  });
}

describe('ggui_ops_list_credit_transactions — kind is an open vocabulary (ggui#1532)', () => {
  it('names the four kinds it knows', () => {
    expect([...KNOWN_CREDIT_TRANSACTION_KINDS]).toEqual(['free_credit', 'render_charge', 'topup', 'refund']);
  });

  it('its declared output accepts a kind it does not know, and every known one', () => {
    const output = z.object(handlerOver([]).outputSchema);
    for (const kind of [...KNOWN_CREDIT_TRANSACTION_KINDS, 'a_kind_this_package_never_named']) {
      expect(output.safeParse({ transactions: [row(kind)] }).success, kind).toBe(true);
    }
    // Control: the member is still required and still a non-empty string.
    expect(output.safeParse({ transactions: [row('')] }).success).toBe(false);
  });

  it('hands an unknown kind through verbatim, never relabelled as a render charge', async () => {
    const out = await handlerOver([row('a_kind_this_package_never_named')]).handler({}, { appId: 'app-1', userId: 'u-1', requestId: 'r' });
    expect(out).toMatchObject({ transactions: [{ kind: 'a_kind_this_package_never_named' }] });
  });

  it('tells the reader, in the tool description and the member description, that the vocabulary is open', () => {
    const h = handlerOver([]);
    expect(h.description).toContain('open vocabulary');
    expect(h.description).toContain('never as a render charge');
    const member = h.outputSchema.transactions.element.shape.kind;
    expect(member.description ?? '').toContain('open vocabulary');
  });
});
