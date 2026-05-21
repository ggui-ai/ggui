/**
 * Seam types for the `ops-coupon` MCP tool family. Mirrors a
 * coupon-redemption operation that atomically:
 *
 *   1. Flips the coupon status from `issued` → `activated`.
 *   2. Credits the wallet (user or org).
 *   3. Inserts a ledger row.
 *
 * Pure over `@ggui-ai/protocol` shapes — NO AWS imports.
 */

/**
 * Result of a successful redemption — mirrors the `RedeemCouponResult`
 * AppSync custom type.
 */
export interface RedeemCouponResult {
  readonly couponCode: string;
  readonly creditCents: number;
  readonly redeemedByPrincipalType: 'user' | 'org';
  readonly redeemedByPrincipalId: string;
  readonly activatedAt: string;
}

/**
 * Read+write seam for the coupon redeem path. Cloud pod implements
 * this against the `redeemCoupon` AppSync mutation; tests use
 * in-memory state.
 *
 * Invariants every implementation MUST honor:
 *   - Rejects already-activated codes with `CouponAlreadyRedeemedError`.
 *   - Rejects expired codes with `CouponExpiredError`.
 *   - Rejects unknown codes with `CouponNotFoundError`.
 *   - When `targetOrgId` is set, the implementation MUST verify the
 *     caller is a member of the org before crediting — else throw
 *     `CouponAccessDeniedError`. User-wallet redemptions need no
 *     such check.
 */
export interface CouponRedeemSource {
  redeem(args: {
    ownerSub: string;
    couponCode: string;
    targetOrgId?: string;
  }): Promise<RedeemCouponResult>;
}

export class CouponNotFoundError extends Error {
  readonly code = 'coupon_not_found' as const;
  constructor(couponCode: string) {
    super(
      `coupon_not_found: no coupon ${JSON.stringify(couponCode)} exists`,
    );
    this.name = 'CouponNotFoundError';
  }
}

export class CouponAlreadyRedeemedError extends Error {
  readonly code = 'coupon_already_redeemed' as const;
  constructor(couponCode: string) {
    super(
      `coupon_already_redeemed: coupon ${JSON.stringify(couponCode)} has already been activated`,
    );
    this.name = 'CouponAlreadyRedeemedError';
  }
}

export class CouponExpiredError extends Error {
  readonly code = 'coupon_expired' as const;
  constructor(couponCode: string) {
    super(`coupon_expired: coupon ${JSON.stringify(couponCode)} expired`);
    this.name = 'CouponExpiredError';
  }
}

export class CouponAccessDeniedError extends Error {
  readonly code = 'coupon_access_denied' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CouponAccessDeniedError';
  }
}
