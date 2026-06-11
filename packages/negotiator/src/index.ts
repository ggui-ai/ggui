/**
 * @ggui-ai/negotiator — open-source contract-synthesis + match-judge
 * engine for ggui's handshake.
 *
 * Given an agent's draft contract + intent, this package:
 *   - synthesizes / repairs a conforming `DataContract`
 *     (`synthesizeContract`, `ensureConformingContract`) so the
 *     handshake always returns a valid contract;
 *   - judges blueprint-match candidates for reuse (`rerankCandidates`);
 *   - validates contract structure + novelty (`contract-validators`);
 *   - hashes contracts into identity + variant keys (`hashContract`,
 *     `buildVariant`) and normalizes untrusted drafts (`normalizeDraft`).
 *
 * The HANDSHAKE DECISION itself (find-similar → reuse vs synth-create)
 * lives in the shared `decideHandshake` core in
 * `@ggui-ai/mcp-server-handlers`, which composes these primitives; the
 * former in-package `negotiate()` RAG+decision pipeline was retired in
 * favor of that unified, adapter-injected core.
 *
 * Composes the storage seams defined in `@ggui-ai/mcp-server-core`
 * (`EmbeddingProvider`, `VectorStore`) so this package stays
 * deployment-agnostic.
 *
 * This barrel stays narrow — it exports only the minimum surface
 * consumers need. Each additive export carries semver weight.
 */

export { hashContract, buildVariant } from './contract-hash.js';
export type { LLMCaller, LLMCallerConfig, ToolSchema } from './llm-caller.js';
export { rerankCandidates } from './llm-rerank.js';
export type {
  RerankCandidate,
  RerankDecision,
  RerankQuery,
} from './llm-rerank.js';
export { synthesizeContract } from './synthesize-contract.js';
export type { SynthesizeContractResult } from './synthesize-contract.js';
export { ensureConformingContract } from './ensure-conforming-contract.js';
export type { EnsureConformingResult } from './ensure-conforming-contract.js';
export { normalizeDraft } from './normalize-draft.js';
export {
  validateContractRedundancy,
  validateContractNovelty,
  formatValidationFindings,
} from './contract-validators.js';
export type {
  ContractValidationFinding,
  ContractValidationFindingKind,
  ContractValidationResult,
  ContractValidationNoveltyDeps,
  ContractValidationNoveltyOptions,
} from './contract-validators.js';
