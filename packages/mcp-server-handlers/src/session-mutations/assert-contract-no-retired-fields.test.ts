import { describe, expect, it } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import {
  ContractRetiredFieldError,
  assertContractNoRetiredFields,
} from './assert-contract-no-retired-fields.js';

describe('assertContractNoRetiredFields', () => {
  it('passes a clean contract', () => {
    const contract: DataContract = {
      propsSpec: {
        properties: { foo: { schema: { type: 'string' } } },
      },
    };
    expect(() => assertContractNoRetiredFields(contract)).not.toThrow();
  });

  it('rejects a contract carrying the retired `libraries` field', () => {
    const contract = { libraries: {} } as unknown as DataContract;
    expect(() => assertContractNoRetiredFields(contract)).toThrow(
      ContractRetiredFieldError,
    );
    expect(() => assertContractNoRetiredFields(contract)).toThrow(
      /'libraries' → use clientCapabilities\.gadgets/,
    );
  });

  it('lists every retired field in a single error', () => {
    const contract = {
      libraries: {},
      dispatch: {},
      capabilities: {},
    } as unknown as DataContract;
    try {
      assertContractNoRetiredFields(contract);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractRetiredFieldError);
      const e = err as ContractRetiredFieldError;
      expect(e.retiredFields).toEqual(['libraries', 'dispatch', 'capabilities']);
    }
  });

  it('rejects `broadcast` (replaced by streamSpec[ch].source)', () => {
    const contract = { broadcast: { x: { tool: 'y' } } } as unknown as DataContract;
    expect(() => assertContractNoRetiredFields(contract)).toThrow(
      /'broadcast' → use streamSpec\[ch\]\.source/,
    );
  });

  it('rejects `wiredTools` and `clientTools`', () => {
    expect(() =>
      assertContractNoRetiredFields({ wiredTools: {} } as unknown as DataContract),
    ).toThrow(/wiredTools.*agentCapabilities\.tools/);
    expect(() =>
      assertContractNoRetiredFields({ clientTools: {} } as unknown as DataContract),
    ).toThrow(/clientTools.*clientCapabilities\.gadgets/);
  });
});
