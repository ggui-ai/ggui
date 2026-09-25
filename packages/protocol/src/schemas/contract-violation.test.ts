import { describe, expect, it } from 'vitest';
import { contractViolationSchema } from './contract-violation.js';
import type { ContractViolation } from '../validation/contract-validator.js';

describe('contractViolationSchema — zod mirror of ContractViolation (#1358)', () => {
  it('parses the finding shape validateActionData produces, optional facts included or not', () => {
    const full: ContractViolation = {
      field: 'answer',
      message: 'must be a string',
      expected: 'string',
      received: 'number',
      keyword: 'type',
    };
    expect(contractViolationSchema.parse(full)).toEqual(full);
    expect(contractViolationSchema.parse({ field: 'answer', message: 'required' })).toEqual({
      field: 'answer',
      message: 'required',
    });
  });

  it('keeps further JSON members a validator may add (the type extends JsonObject) and refuses a finding with no field or message', () => {
    expect(contractViolationSchema.parse({ field: 'a', message: 'm', path: '/a' })).toEqual({ field: 'a', message: 'm', path: '/a' });
    expect(contractViolationSchema.safeParse({ message: 'm' }).success).toBe(false);
    expect(contractViolationSchema.safeParse({ field: 'a' }).success).toBe(false);
  });
});
