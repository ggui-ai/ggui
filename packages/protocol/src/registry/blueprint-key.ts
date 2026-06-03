/**
 * Deterministic identity hash for a `DataContract` shape.
 *
 * `blueprintKey(contract)` is the Tier 1 exact-match key in the
 * blueprint registry: two contract that canonicalize to the same
 * string produce the same key, regardless of how the agent
 * paraphrased the surrounding intent. Equal key → guaranteed
 * registry lookup hit (no LLM rerank, no embedding similarity).
 *
 * 16-character sha256 prefix — matches the existing `blueprintHash`
 * shape in `cache-trace-sink` and `generation-cache.ts`. Collision
 * probability for 100s-of-thousands of distinct contract is ~10^-6
 * (birthday-bound on 2^64), well below the budget for the OSS
 * single-tenant scope. Hosted multi-tenant deployments scope keys
 * by appId so the bound is per-tenant, never global.
 */
import { createHash } from 'node:crypto';
import type { DataContract } from '../types/data-contract.js';
import { canonicalizeContracts } from './canonicalize-contract.js';

/**
 * Compute the canonical 16-char identity hash for a contract shape.
 *
 * Pure function, no I/O. Deterministic across runs / processes /
 * Node versions (sha256 + utf-8 encoding are well-specified).
 */
export function blueprintKey(contract: DataContract | undefined): string {
  const canonical = canonicalizeContracts(contract);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// The `@ggui-ai/protocol/blueprint-key` subpath maps to this single
// file (NOT a barrel), so the variant axis of the reuse key must be
// re-exported here to be importable at that subpath alongside
// `blueprintKey`. See `variant-key.ts` for the implementation.
export { variantKey } from './variant-key.js';

export {
  toPortableBlueprint,
  fromPortableBlueprint,
  type PortableBlueprintSource,
  type PortableBlueprintImport,
} from './portable-blueprint.js';
