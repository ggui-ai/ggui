/**
 * Deterministic identity hash for a `DataContract` shape.
 *
 * `blueprintKey(contract)` is the Tier 1 exact-match key in the
 * blueprint registry: two contracts that canonicalize to the same
 * string produce the same key. Equal key → guaranteed registry
 * lookup hit (no LLM rerank, no embedding similarity).
 *
 * The key covers the contract OBJECT and nothing else (ggui#1137):
 *   - The `intent` argument of `ggui_handshake` is not an input, so
 *     rewording that sentence does not move the key.
 *   - Every key the contract object itself carries is hashed, declared
 *     or not: `dataContractSchema` passes unknown keys through, and the
 *     canonicalizer strips only string-valued `description` / `usage`
 *     and a tool's `serverInfo.version`. So a contract object that
 *     carries its own `intent` key keys on that sentence: the same
 *     specs with a different, or no, `intent` key give three different
 *     keys.
 *
 * 16-character sha256 prefix — matches the existing `blueprintHash`
 * shape in `cache-trace-sink` and `generation-cache.ts`. Collision
 * probability for 100s-of-thousands of distinct contract is ~10^-6
 * (birthday-bound on 2^64), well below the budget for a single
 * deployment's key space. A deployment that serves many apps scopes
 * keys by `appId`, so the bound holds per app, never across the whole
 * store.
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
  PORTABLE_BLUEPRINT_SCHEMA_VERSION,
  PORTABLE_BLUEPRINT_V1_REJECTION,
  type PortableBlueprintSource,
  type PortableBlueprintImportResult,
} from './portable-blueprint.js';

// `computeToolCatalogHash` pulls `node:crypto`, so it lives behind this
// server-only subpath alongside `blueprintKey` rather than the root barrel.
export * from './blueprint-stamp.js';
