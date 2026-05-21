/**
 * `ggui_ops_redeem_coupon` — redeem a `cpn_*` coupon code, crediting
 * the caller's wallet (default) or a target org's wallet.
 *
 * Sibling of the AppSync `redeemCoupon` mutation
 * (`backend/amplify/data/redeem-coupon/`). The adapter runs an atomic
 * TransactWrite: coupon status flip + wallet balance update + ledger
 * insert. Failure of any leg rolls all back — no half-credit, no
 * double-spend.
 *
 * Pure over the {@link CouponRedeemSource} seam.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from '../ops-apps/identity.js';
import type { CouponRedeemSource, RedeemCouponResult } from './types.js';

const inputSchema = {
  couponCode: z
    .string()
    .min(1)
    .describe(
      "The bearer-secret code in format `cpn_<8 chars>`. One-time redemption — repeat calls with the same code throw `coupon_already_redeemed`.",
    ),
  targetOrgId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "When set, credits the named org's wallet instead of the caller's personal wallet. Caller MUST be a member of the org — else `coupon_access_denied`.",
    ),
} as const;

const outputSchema = {
  couponCode: z.string(),
  creditCents: z.number().int(),
  redeemedByPrincipalType: z.enum(['user', 'org']),
  redeemedByPrincipalId: z.string(),
  activatedAt: z.string(),
} as const;

export interface RedeemCouponOutput {
  readonly couponCode: string;
  readonly creditCents: number;
  readonly redeemedByPrincipalType: 'user' | 'org';
  readonly redeemedByPrincipalId: string;
  readonly activatedAt: string;
}

export interface RedeemCouponDeps {
  readonly coupons: CouponRedeemSource;
}

export function createRedeemCouponHandler(
  deps: RedeemCouponDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  RedeemCouponOutput
> {
  return {
    name: 'ggui_ops_redeem_coupon',
    title: 'Redeem coupon',
    audience: ['ops'],
    description:
      "Redeem a `cpn_*` coupon code. Default target is the calling user's wallet; pass `targetOrgId` to credit an org wallet instead (caller must be a member). Atomic three-leg write: coupon status flip + wallet credit + ledger insert. One-time — repeats fail with `coupon_already_redeemed`. Expired/unknown codes throw the matching error.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<RedeemCouponOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_redeem_coupon', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const result: RedeemCouponResult = await deps.coupons.redeem({
        ownerSub,
        couponCode: parsed.couponCode,
        ...(parsed.targetOrgId !== undefined
          ? { targetOrgId: parsed.targetOrgId }
          : {}),
      });
      return {
        couponCode: result.couponCode,
        creditCents: result.creditCents,
        redeemedByPrincipalType: result.redeemedByPrincipalType,
        redeemedByPrincipalId: result.redeemedByPrincipalId,
        activatedAt: result.activatedAt,
      };
    },
  };
}
