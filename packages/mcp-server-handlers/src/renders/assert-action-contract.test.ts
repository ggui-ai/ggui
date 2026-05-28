import { describe, it, expect } from 'vitest';
import { ContractViolationError, type ActionSpec } from '@ggui-ai/protocol';
import { assertActionContract } from './assert-action-contract.js';

const SPEC: ActionSpec = {
  submit: {
    label: 'Submit',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  archive: { label: 'Archive', nextStep: 'archive_record' }, // void-payload action
};

describe('assertActionContract', () => {
  it('is a no-op when spec is undefined (no contract = nothing to enforce)', () => {
    expect(() =>
      assertActionContract(undefined, { action: 'anything', data: {} }),
    ).not.toThrow();
  });

  it('passes for declared action with matching payload', () => {
    expect(() =>
      assertActionContract(SPEC, { action: 'submit', data: { text: 'hi' } }),
    ).not.toThrow();
  });

  it('passes for declared void-payload action with no data', () => {
    expect(() => assertActionContract(SPEC, { action: 'archive' })).not.toThrow();
  });

  it('rejects undeclared action with tool=ggui_event', () => {
    let err: unknown;
    try {
      assertActionContract(SPEC, { action: 'deleteAccount', data: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContractViolationError);
    expect((err as ContractViolationError).tool).toBe('ggui_event');
  });

  it('rejects non-object value (e.g. string action-id alone)', () => {
    expect(() => assertActionContract(SPEC, 'submit')).toThrow(ContractViolationError);
  });

  it('rejects malformed payload for declared action', () => {
    // `submit` requires `data.text:string`; top-level type mismatch when data isn't an object.
    let err: unknown;
    try {
      assertActionContract(SPEC, { action: 'submit', data: 'not-an-object' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContractViolationError);
    expect((err as ContractViolationError).tool).toBe('ggui_event');
  });

  it('uses the action-specific default hint on violations', () => {
    try {
      assertActionContract(SPEC, { action: 'deleteAccount' });
      throw new Error('should have thrown');
    } catch (e) {
      if (e instanceof ContractViolationError) {
        expect(e.hint).toContain('actionSpec');
      } else {
        throw e;
      }
    }
  });
});
