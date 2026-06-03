import type { PortableBlueprint } from '../types/portable-blueprint.js';
import type { DataContract } from '../types/data-contract.js';
import type { BlueprintVariance } from '../types/blueprint.js';
import { blueprintKey, variantKey } from './blueprint-key.js';

export type { PortableBlueprint };

/** The fields needed to mint a {@link PortableBlueprint} (keys are derived). */
export interface PortableBlueprintSource {
  readonly contract: DataContract;
  readonly componentCode: string;
  readonly variance: BlueprintVariance;
}

/** The fields a loader feeds to the registry, plus an integrity flag. */
export interface PortableBlueprintImport {
  readonly input: PortableBlueprintSource;
  /** True if the shipped contractHash/variantKey differed from the recompute. */
  readonly keyMismatch: boolean;
}

export function toPortableBlueprint(src: PortableBlueprintSource): PortableBlueprint {
  return {
    schemaVersion: 1,
    contract: src.contract,
    componentCode: src.componentCode,
    variance: src.variance,
    contractHash: blueprintKey(src.contract),
    variantKey: variantKey(src.variance),
  };
}

export function fromPortableBlueprint(record: PortableBlueprint): PortableBlueprintImport {
  const recomputedContract = blueprintKey(record.contract);
  const recomputedVariant = variantKey(record.variance);
  const keyMismatch =
    recomputedContract !== record.contractHash ||
    recomputedVariant !== record.variantKey;
  return {
    input: {
      contract: record.contract,
      componentCode: record.componentCode,
      variance: record.variance,
    },
    keyMismatch,
  };
}
