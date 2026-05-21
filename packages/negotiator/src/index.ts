/**
 * @ggui-ai/negotiator — open-source UI decision engine for ggui.
 *
 * Decides which UI to render (create/update/compose/replace) given agent
 * signal (data/prompt/context/agentTools) and current session state.
 *
 * Composes the storage seams defined in `@ggui-ai/mcp-server-core`
 * (`EmbeddingProvider`, `VectorStore`, `Negotiator`). The decision
 * semantics are open here; concrete cloud-vendor bindings (e.g. a
 * managed embedding service or vector store) live behind those seams
 * so this package stays deployment-agnostic.
 *
 * This barrel stays narrow — it exports only the minimum surface
 * consumers need. Each additive export carries semver weight.
 */

export { hashContract, buildVariant } from './contract-hash.js';
export { computeIntentId, shouldSuppressSuggestion } from './intent.js';
export { detectDataPatterns, buildSuggestion } from './suggestion.js';
export type { NegotiatorSuggestion } from './suggestion.js';
export { inferInteractionMode, inferJsonSchemaType } from './pure.js';
export { ragSearch } from './rag-search.js';
export type {
  RagSearchDeps,
  RagSearchInput,
  RagSearchResult,
} from './rag-search.js';
export type { NegotiatorOption } from './types.js';
export type { LLMCaller, LLMCallerConfig, ToolSchema } from './llm-caller.js';
export type { SessionState, SessionStackEntry } from './session.js';
export type { NegotiatorDecisionInput } from './decision-input.js';
export {
  DECISION_SYSTEM_PROMPT,
  buildDecisionUserMessage,
  makeDecision,
} from './decision.js';
export { negotiate } from './negotiate.js';
export type {
  NegotiateDeps,
  NegotiateInput,
  NegotiateConfig,
  NegotiateResult,
} from './negotiate.js';
export { rerankCandidates } from './llm-rerank.js';
export type {
  RerankCandidate,
  RerankDecision,
  RerankQuery,
} from './llm-rerank.js';
export { synthesizeContract } from './synthesize-contract.js';
export type { SynthesizeContractResult } from './synthesize-contract.js';
export {
  validateContractStructure,
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
