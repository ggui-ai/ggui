import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createRedeemCouponHandler } from './redeem-coupon.js';
import { InMemoryCouponRedeemSource } from './in-memory-fake.test-util.js';
import {
  CouponAccessDeniedError,
  CouponAlreadyRedeemedError,
  CouponExpiredError,
  CouponNotFoundError,
} from './types.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createRedeemCouponHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createRedeemCouponHandler({
      coupons: new InMemoryCouponRedeemSource(),
    });
    expect(handler.name).toBe('ggui_ops_redeem_coupon');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createRedeemCouponHandler — happy path', () => {
  it('redeems to the calling user’s wallet by default', async () => {
    const coupons = new InMemoryCouponRedeemSource();
    coupons.seedCoupon({ couponCode: 'cpn_abc12345', creditCents: 500 });
    const handler = createRedeemCouponHandler({ coupons });
    const result = await handler.handler(
      { couponCode: 'cpn_abc12345' },
      makeCtx(),
    );
    expect(result.creditCents).toBe(500);
    expect(result.redeemedByPrincipalType).toBe('user');
    expect(result.redeemedByPrincipalId).toBe('user-1');
  });

  it('redeems to an org wallet when caller is a member', async () => {
    const coupons = new InMemoryCouponRedeemSource();
    coupons.seedCoupon({ couponCode: 'cpn_abc12345', creditCents: 500 });
    coupons.seedOrgMembership('org_team1', 'user-1');
    const handler = createRedeemCouponHandler({ coupons });
    const result = await handler.handler(
      { couponCode: 'cpn_abc12345', targetOrgId: 'org_team1' },
      makeCtx(),
    );
    expect(result.redeemedByPrincipalType).toBe('org');
    expect(result.redeemedByPrincipalId).toBe('org_team1');
  });
});

describe('createRedeemCouponHandler — denials', () => {
  it('rejects unknown codes with CouponNotFoundError', async () => {
    const handler = createRedeemCouponHandler({
      coupons: new InMemoryCouponRedeemSource(),
    });
    await expect(
      handler.handler({ couponCode: 'cpn_nope' }, makeCtx()),
    ).rejects.toBeInstanceOf(CouponNotFoundError);
  });

  it('rejects double redemption with CouponAlreadyRedeemedError', async () => {
    const coupons = new InMemoryCouponRedeemSource();
    coupons.seedCoupon({ couponCode: 'cpn_abc12345', creditCents: 500 });
    const handler = createRedeemCouponHandler({ coupons });
    await handler.handler({ couponCode: 'cpn_abc12345' }, makeCtx());
    await expect(
      handler.handler({ couponCode: 'cpn_abc12345' }, makeCtx()),
    ).rejects.toBeInstanceOf(CouponAlreadyRedeemedError);
  });

  it('rejects expired codes with CouponExpiredError', async () => {
    const coupons = new InMemoryCouponRedeemSource();
    // Already-expired at creation
    coupons.seedCoupon({
      couponCode: 'cpn_old',
      creditCents: 500,
      expiresAtMs: 100,
    });
    coupons.advanceClock(1000);
    const handler = createRedeemCouponHandler({ coupons });
    await expect(
      handler.handler({ couponCode: 'cpn_old' }, makeCtx()),
    ).rejects.toBeInstanceOf(CouponExpiredError);
  });

  it('rejects non-member org redemption with CouponAccessDeniedError', async () => {
    const coupons = new InMemoryCouponRedeemSource();
    coupons.seedCoupon({ couponCode: 'cpn_abc12345', creditCents: 500 });
    const handler = createRedeemCouponHandler({ coupons });
    await expect(
      handler.handler(
        { couponCode: 'cpn_abc12345', targetOrgId: 'org_unknown' },
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(CouponAccessDeniedError);
  });

  it('throws on empty identity', async () => {
    const handler = createRedeemCouponHandler({
      coupons: new InMemoryCouponRedeemSource(),
    });
    await expect(
      handler.handler(
        { couponCode: 'cpn_abc12345' },
        { appId: '', requestId: 'r' },
      ),
    ).rejects.toThrow();
  });
});
