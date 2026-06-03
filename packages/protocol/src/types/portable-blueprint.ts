import type { DataContract } from './data-contract.js';
import type { BlueprintVariance } from './blueprint.js';

/**
 * One self-contained, JSON-serializable blueprint record in a
 * distributable shared-pool artifact. A blueprint is a COMPLETED
 * TEMPLATE (a whole generated UI keyed by a contract) — not a
 * component — so there is no `kind`/atomic-taxonomy field; that
 * taxonomy belongs to the separate component library. Carries the
 * component code inline (the stored Blueprint references code by hash;
 * the artifact must travel with the bytes). `contractHash` /
 * `variantKey` are shipped for diagnostics + integrity and are
 * recomputed on load.
 */
export interface PortableBlueprint {
  readonly schemaVersion: 1;
  readonly contract: DataContract;
  readonly componentCode: string;
  readonly variance: BlueprintVariance;
  readonly contractHash: string;
  readonly variantKey: string;
}
