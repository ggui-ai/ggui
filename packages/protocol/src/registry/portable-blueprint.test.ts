import { describe, it, expect } from 'vitest';
import {
  toPortableBlueprint,
  fromPortableBlueprint,
  type PortableBlueprintSource,
} from './portable-blueprint.js';
import { blueprintKey, variantKey } from './blueprint-key.js';
import type { DataContract } from '../types/data-contract.js';

const contract: DataContract = {
  propsSpec: { properties: { title: { schema: { type: 'string' } } } },
};

const src: PortableBlueprintSource = {
  contract,
  componentCode: 'export default function C(){return null}',
  variance: { persona: 'minimal' },
};

describe('toPortableBlueprint', () => {
  it('computes canonical keys and stamps schemaVersion', () => {
    const p = toPortableBlueprint(src);
    expect(p.schemaVersion).toBe(1);
    expect(p.contractHash).toBe(blueprintKey(contract));
    expect(p.variantKey).toBe(variantKey({ persona: 'minimal' }));
    expect(p.componentCode).toBe(src.componentCode);
  });

  it('is deterministic across calls (portable identity)', () => {
    expect(toPortableBlueprint(src).contractHash).toBe(
      toPortableBlueprint({ ...src, contract: { ...contract } }).contractHash,
    );
  });
});

describe('fromPortableBlueprint', () => {
  it('recomputes keys and flags shipped-key mismatch', () => {
    const tampered = { ...toPortableBlueprint(src), contractHash: 'deadbeefdeadbeef' };
    const { input, keyMismatch } = fromPortableBlueprint(tampered);
    expect(input.contract).toEqual(contract);
    expect(input.componentCode).toBe(src.componentCode);
    expect(keyMismatch).toBe(true); // recompute wins, mismatch surfaced
  });

  it('reports no mismatch for an untampered record', () => {
    expect(fromPortableBlueprint(toPortableBlueprint(src)).keyMismatch).toBe(false);
  });
});
