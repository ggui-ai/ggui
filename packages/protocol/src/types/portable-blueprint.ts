import type { DataContract } from "./data-contract.js";
import type { BlueprintVariance } from "./blueprint.js";

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
  /**
   * Generator era at export time (`PROTOCOL_VERSION`). Importers reject
   * blueprints whose generator era is incompatible with theirs rather than
   * serve code generated against a different protocol shape. Optional for
   * back-compat with pre-stamp artifacts (treated as "unknown → warn").
   */
  readonly generatorProtocolVersion?: string;
  /**
   * SHA256(16) of the tool-identity catalog used to canonicalize `contract`
   * at export. Importers re-canonicalize against their own catalog and
   * recompute the key; a divergence means the same intent would mis-key and
   * silently cold-gen — so it is rejected. Optional for back-compat.
   */
  readonly toolIdentityCatalogHash?: string;
}
