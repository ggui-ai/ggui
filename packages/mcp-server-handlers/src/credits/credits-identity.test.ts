/**
 * Identity-derivation pins for the credits handler family.
 *
 * Credit rows are keyed by USER identity. On multi-tenant hosts
 * `ctx.appId` names the caller's active app — never the caller — so a
 * handler that reads `ctx.appId` alone silently returns the zero-row
 * fallback for every such caller (the live 2026-08-15 finding behind
 * ggui#512: a $5.00 account quoted as $0.00). These tests pin the
 * derivation: `ctx.userId` wins when present, `ctx.appId` is the
 * single-tenant fallback, and both-absent throws.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createGetCreditBalanceHandler,
  type CreditBalanceView,
} from './get-credit-balance.js';
import { createListCreditTransactionsHandler } from './list-credit-transactions.js';
import type { HandlerContext } from '../types.js';

const BALANCE: CreditBalanceView = {
  balanceCents: 500,
  lifetimeGrantedCents: 500,
  lifetimeSpentCents: 0,
  updatedAt: '2026-08-15T00:00:00.000Z',
};

function ctxWith(overrides: Partial<HandlerContext>): HandlerContext {
  return { appId: 'app-1', requestId: 'req-1', ...overrides };
}

describe('credits family — caller identity derivation (ggui#512)', () => {
  describe('ggui_get_credit_balance', () => {
    it('keys the read by ctx.userId when the host resolves one', async () => {
      const getBalance = vi.fn().mockResolvedValue(BALANCE);
      const tool = createGetCreditBalanceHandler({
        creditBalance: { getBalance },
      });
      const out = await tool.handler(
        {},
        ctxWith({ userId: 'user-sub-1', appId: 'active-app-9' }),
      );
      expect(getBalance).toHaveBeenCalledWith('user-sub-1');
      expect(out.balanceCents).toBe(500);
    });

    it('falls back to ctx.appId for single-tenant hosts (no userId)', async () => {
      const getBalance = vi.fn().mockResolvedValue(BALANCE);
      const tool = createGetCreditBalanceHandler({
        creditBalance: { getBalance },
      });
      await tool.handler({}, ctxWith({ appId: 'folded-user-id' }));
      expect(getBalance).toHaveBeenCalledWith('folded-user-id');
    });

    it('throws when neither identity slot is set', async () => {
      const getBalance = vi.fn();
      const tool = createGetCreditBalanceHandler({
        creditBalance: { getBalance },
      });
      await expect(
        tool.handler({}, ctxWith({ appId: '' })),
      ).rejects.toThrow(/missing caller identity/);
      expect(getBalance).not.toHaveBeenCalled();
    });
  });

  describe('ggui_list_credit_transactions', () => {
    it('keys the read by ctx.userId when the host resolves one', async () => {
      const list = vi.fn().mockResolvedValue({ transactions: [] });
      const tool = createListCreditTransactionsHandler({
        creditTransactions: { list },
      });
      await tool.handler(
        {},
        ctxWith({ userId: 'user-sub-1', appId: 'active-app-9' }),
      );
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-sub-1' }),
      );
    });

    it('falls back to ctx.appId for single-tenant hosts (no userId)', async () => {
      const list = vi.fn().mockResolvedValue({ transactions: [] });
      const tool = createListCreditTransactionsHandler({
        creditTransactions: { list },
      });
      await tool.handler({}, ctxWith({ appId: 'folded-user-id' }));
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'folded-user-id' }),
      );
    });
  });
});
