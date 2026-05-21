/**
 * In-memory fake for the `CouponRedeemSource` seam, used by
 * `ops-coupon` test files.
 */

import type {
  CouponRedeemSource,
  RedeemCouponResult,
} from './types.js';
import {
  CouponAccessDeniedError,
  CouponAlreadyRedeemedError,
  CouponExpiredError,
  CouponNotFoundError,
} from './types.js';

interface InternalCoupon {
  readonly couponCode: string;
  readonly creditCents: number;
  readonly expiresAt: number;
  status: 'issued' | 'activated';
  redeemedByPrincipalType?: 'user' | 'org';
  redeemedByPrincipalId?: string;
  redeemedByUserId?: string;
  activatedAt?: string;
}

export class InMemoryCouponRedeemSource implements CouponRedeemSource {
  private readonly coupons = new Map<string, InternalCoupon>();
  /** orgId → membership Set<userId>. */
  private readonly orgMembers = new Map<string, Set<string>>();
  private clock = 0;

  private now(): string {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }

  seedCoupon(args: {
    couponCode: string;
    creditCents: number;
    /** Absolute expiry ms-since-epoch. Default: far future. */
    expiresAtMs?: number;
  }): void {
    this.coupons.set(args.couponCode, {
      couponCode: args.couponCode,
      creditCents: args.creditCents,
      expiresAt: args.expiresAtMs ?? Date.now() + 365 * 24 * 3600 * 1000,
      status: 'issued',
    });
  }

  seedOrgMembership(orgId: string, userId: string): void {
    const set = this.orgMembers.get(orgId) ?? new Set<string>();
    set.add(userId);
    this.orgMembers.set(orgId, set);
  }

  async redeem(args: {
    ownerSub: string;
    couponCode: string;
    targetOrgId?: string;
  }): Promise<RedeemCouponResult> {
    const existing = this.coupons.get(args.couponCode);
    if (!existing) {
      throw new CouponNotFoundError(args.couponCode);
    }
    if (existing.status === 'activated') {
      throw new CouponAlreadyRedeemedError(args.couponCode);
    }
    if (existing.expiresAt < this.clock) {
      throw new CouponExpiredError(args.couponCode);
    }
    if (args.targetOrgId !== undefined) {
      const set = this.orgMembers.get(args.targetOrgId);
      if (!set || !set.has(args.ownerSub)) {
        throw new CouponAccessDeniedError(
          `caller ${args.ownerSub} is not a member of org ${args.targetOrgId}`,
        );
      }
    }
    const activatedAt = this.now();
    const principalType = args.targetOrgId ? 'org' : 'user';
    const principalId = args.targetOrgId ?? args.ownerSub;
    existing.status = 'activated';
    existing.activatedAt = activatedAt;
    existing.redeemedByPrincipalType = principalType;
    existing.redeemedByPrincipalId = principalId;
    existing.redeemedByUserId = args.ownerSub;
    return {
      couponCode: existing.couponCode,
      creditCents: existing.creditCents,
      redeemedByPrincipalType: principalType,
      redeemedByPrincipalId: principalId,
      activatedAt,
    };
  }

  /** Advance the in-fake clock so an `expiresAtMs` already-past time
   * triggers `CouponExpiredError`. */
  advanceClock(toMs: number): void {
    this.clock = toMs;
  }
}
