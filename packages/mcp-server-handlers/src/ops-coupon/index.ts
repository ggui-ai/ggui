/**
 * Operator-class coupon handler family.
 *
 * One MCP tool, `audience: ['ops']`, served on `/ops`:
 *
 *   - `createRedeemCouponHandler` → `ggui_ops_redeem_coupon`
 *
 * Pure over the {@link CouponRedeemSource} seam. Cloud deployments
 * wrap a real coupon-redemption backend; tests use in-memory state.
 */

export type { CouponRedeemSource, RedeemCouponResult } from './types.js';
export {
  CouponNotFoundError,
  CouponAlreadyRedeemedError,
  CouponExpiredError,
  CouponAccessDeniedError,
} from './types.js';

export { createRedeemCouponHandler } from './redeem-coupon.js';
export type {
  RedeemCouponDeps,
  RedeemCouponOutput,
} from './redeem-coupon.js';
