import { describe, expect, it } from 'vitest';

import {
  OWNER_API_REFUSAL_CODES,
  PRE_GENERATION_REFUSAL_ROWS,
  RENDER_GATE_REFUSAL_CODES,
} from '../refusal-codes';

/**
 * ggui#960 — registry v11: the retail plan model is retired (founder,
 * 2026-09-08: one product, prepaid pay-as-you-go at flat rates; trial and
 * tiers gone; welcome credit is the free entry). Every code whose emitting
 * arm left with it retires here, in the same slice — a registry row with
 * no emitter is a phantom (#910). And the registry's own words follow the
 * model: no surviving row describes a plan, tier, trial or subscription.
 */
describe('refusal registry v11 (ggui#960)', () => {
  it('render-gate codes are exactly the eleven survivors, in registry order', () => {
    expect([...RENDER_GATE_REFUSAL_CODES]).toEqual([
      'unsupported_provider',
      'insufficient_credit',
      'hard_cap_exceeded',
      'model_not_allowed',
      'managed_default_cap_exceeded',
      'app_policy_missing',
      'billing_mode_anomaly',
      'billing_path_missing',
      'issuer_rate_limited',
      'app_rate_limited',
      'app_deprovisioned',
    ]);
  });

  it('owner-api codes are exactly the one surviving top-up refusal', () => {
    expect([...OWNER_API_REFUSAL_CODES]).toEqual(['checkout_unavailable']);
  });

  it('the eleven retired codes are not registry rows', () => {
    const retired = [
      'trial_exhausted',
      'trial_expired',
      'app_canceled',
      'subscription_exists',
      'no_subscription',
      'subscription_unchanged',
      'portal_unavailable',
      'card_update_unavailable',
      'managed_app_no_portal',
      'managed_app_no_card_update',
      'managed_app_no_checkout',
    ];
    for (const code of retired) expect(Object.hasOwn(PRE_GENERATION_REFUSAL_ROWS, code), code).toBe(false);
  });

  it("no surviving row's description or emitter speaks of a plan, tier, trial or subscription", () => {
    const banned = /\b(plans?|tiers?|trials?|subscriptions?|subscribe[sd]?)\b/i;
    for (const [code, row] of Object.entries(PRE_GENERATION_REFUSAL_ROWS)) {
      expect(row.description, `${code}.description`).not.toMatch(banned);
      expect(row.emitter, `${code}.emitter`).not.toMatch(banned);
    }
  });
});
