/**
 * ContractViolation.keyword retention — P2 of the schema-precise
 * render plan (docs/plans/2026-08-19-schema-precise-render.md).
 *
 * The render/update telemetry events segment violations by the Ajv
 * keyword that produced them (`violationKeywords`) — the arbiter for
 * whether enum-vocabulary fixes or structural fixes are what a
 * deployment needs. That requires the mapped {@link ContractViolation}
 * to RETAIN the keyword, which the mapper historically dropped.
 */
import { describe, expect, it } from 'vitest';
import { validatePropsData } from './contract-validator.js';
import type { PropsSpec } from '../types/data-contract.js';

const ENUM_SPEC: PropsSpec = {
  properties: {
    status: {
      schema: { type: 'string', enum: ['open', 'busy', 'tentative'] },
      required: true,
    },
  },
};

describe('ContractViolation.keyword', () => {
  it('retains the ajv keyword on an enum violation', () => {
    const result = validatePropsData({ status: 'booked' }, ENUM_SPEC);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.keyword).toBe('enum');
  });

  it('retains the ajv keyword on required + closed-shape violations', () => {
    const missing = validatePropsData({}, ENUM_SPEC);
    expect(missing.valid).toBe(false);
    expect(missing.violations[0]!.keyword).toBe('required');

    const extra = validatePropsData(
      { status: 'open', bogus: 1 },
      ENUM_SPEC,
    );
    expect(extra.valid).toBe(false);
    expect(extra.violations[0]!.keyword).toBe('additionalProperties');
  });
});
