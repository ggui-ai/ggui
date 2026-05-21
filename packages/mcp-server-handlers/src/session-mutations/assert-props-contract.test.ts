import { describe, it, expect } from 'vitest';
import { ContractViolationError, type PropsSpec } from '@ggui-ai/protocol';
import { assertPropsContract } from './assert-props-contract.js';

const SPEC: PropsSpec = {
  properties: {
    city: { required: true, schema: { type: 'string' } },
    temp: { required: false, schema: { type: 'number' } },
  },
};

describe('assertPropsContract', () => {
  it('is a no-op when spec is undefined (missing propsSpec = permissive)', () => {
    expect(() => assertPropsContract(undefined, { anything: 'goes' })).not.toThrow();
  });

  it('passes when required fields present with right types', () => {
    expect(() => assertPropsContract(SPEC, { city: 'Seoul', temp: 15 })).not.toThrow();
  });

  it('passes when only required field present', () => {
    expect(() => assertPropsContract(SPEC, { city: 'Seoul' })).not.toThrow();
  });

  it('throws ContractViolationError{tool:ggui_update} on missing required field', () => {
    let err: unknown;
    try {
      assertPropsContract(SPEC, { temp: 15 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContractViolationError);
    const cve = err as ContractViolationError;
    expect(cve.tool).toBe('ggui_update');
    expect(cve.violations.length).toBeGreaterThan(0);
    expect(cve.violations[0].field).toBe('city');
  });

  it('carries toErrorData() that matches the expected envelope', () => {
    try {
      assertPropsContract(SPEC, {});
      throw new Error('should have thrown');
    } catch (e) {
      if (e instanceof ContractViolationError) {
        expect(e.toErrorData()).toMatchObject({
          error: 'contract_violation',
          tool: 'ggui_update',
        });
      } else {
        throw e;
      }
    }
  });
});
