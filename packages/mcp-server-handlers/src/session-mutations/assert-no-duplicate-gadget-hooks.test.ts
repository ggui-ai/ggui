import { describe, expect, it } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import {
  DuplicateGadgetHookError,
  assertNoDuplicateGadgetHooks,
} from './assert-no-duplicate-gadget-hooks.js';

describe('assertNoDuplicateGadgetHooks', () => {
  it('passes a contract with no clientCapabilities', () => {
    expect(() => assertNoDuplicateGadgetHooks({} as DataContract)).not.toThrow();
  });

  it('passes a contract with distinct hook names', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useCamera: {}, useGeolocation: {} },
        },
      },
    };
    expect(() => assertNoDuplicateGadgetHooks(contract)).not.toThrow();
  });

  // GG.8.8: the wire is package-keyed, so an export name cannot repeat
  // WITHIN one package (object-key uniqueness). The hazard this gate
  // catches is cross-package: two packages each exporting the same
  // name.
  it('rejects the same export name across two packages', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@stripe/ggui-checkout': { useCheckout: {} },
          '@paypal/ggui-checkout': { useCheckout: {} },
        },
      },
    };
    expect(() => assertNoDuplicateGadgetHooks(contract)).toThrow(
      DuplicateGadgetHookError,
    );
  });

  it('surfaces every duplicate in a single error', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@acme/cam-a': { useCamera: {} },
          '@acme/cam-b': { useCamera: {} },
          '@acme/mic-a': { useMicrophone: {} },
          '@acme/mic-b': { useMicrophone: {} },
        },
      },
    };
    try {
      assertNoDuplicateGadgetHooks(contract);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateGadgetHookError);
      const e = err as DuplicateGadgetHookError;
      expect(e.duplicates).toHaveLength(2);
      expect(e.duplicates.map((d) => d.hook).sort()).toEqual([
        'useCamera',
        'useMicrophone',
      ]);
      expect(e.duplicates.map((d) => d.package).sort()).toEqual([
        '@acme/cam-b',
        '@acme/mic-b',
      ]);
    }
  });
});
