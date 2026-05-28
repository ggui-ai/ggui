/**
 * Shared render-mutation helpers. Centralizes the contract-enforcement
 * codepath so hosted + OSS mutation handlers converge on one set of
 * primitives.
 *
 * Post-Phase-B (flatten-render-identity): the prior "renders"
 * surface (vessel-wrapping-a-stack) collapsed to "render-mutations"
 * (a render IS the addressable unit). Helpers + errors renamed; the
 * folder retains its old name to keep import paths stable for one
 * more slice — folder rename will land separately.
 *
 * What's here today (pure + seam-free, depend only on `@ggui-ai/protocol`):
 *
 *   Payload-validation enforcement (schema-shape checks):
 *   - `assertPropsContract(spec, patch)` — validate props against a
 *     PropsSpec; throw `ContractViolationError{tool:'ggui_update'}` on
 *     violation. No-op when spec is absent.
 *   - `assertStreamContract(spec, data)` — same shape for streams.
 *   - `assertActionContract(spec, value)` — same shape for inbound user
 *     actions (live-channel ingress).
 *
 *   Render mutation flow:
 *   - `applyRenderPatch({render, patch})` — pure update flow:
 *     enforce propsSpec, return the updated render.
 *
 *   Typed errors (each maps to a distinct enforcement concern):
 *   - `RenderNotFoundError` — render id missing or cross-tenant
 *   - `ChannelNotDeclaredError` — streamSpec or channel missing
 *   - `InvalidCompleteError` — `complete: true` on a non-completable channel
 *   - `ContractViolationError` (from `@ggui-ai/protocol`) — payload shape
 *     violates the declared schema. Re-exported implicitly via handler
 *     throw sites.
 */
export {
  applyRenderPatch,
  type ApplyRenderPatchInput,
  type ApplyRenderPatchResult,
  type RenderTarget,
} from "./apply-render-patch.js";
export { assertActionContract } from "./assert-action-contract.js";
export {
  assertContractNoRetiredFields,
  ContractRetiredFieldError,
} from "./assert-contract-no-retired-fields.js";
export {
  assertGadgetsRegistered,
  filterDescriptorsToContract,
  findClosestRegisteredHook,
  GadgetNotRegisteredError,
  GadgetPackageMismatchError,
  type PackageMismatchEntry,
  type UnregisteredHookEntry,
} from "./assert-gadgets.js";
export { assertPropsContract } from "./assert-props-contract.js";
export {
  assertPublicEnvSatisfied,
  findClosestPublicEnvKey,
  GadgetPublicEnvMissingError,
  type PublicEnvViolation,
} from "./assert-public-env.js";
export { assertStreamContract } from "./assert-stream-contract.js";
export {
  CACHE_TRACE_INTENT_MAX_BYTES,
  CACHE_TRACE_PROBE_SIZE,
  emitCacheTraceEvent,
  getCacheTraceSink,
  newCacheTraceId,
  setCacheTraceSink,
  truncateCacheTraceIntent,
  type CacheTraceCandidate,
  type CacheTraceDecision,
  type CacheTraceEvent,
  type CacheTraceSink,
  type CacheTraceValidatorFinding,
} from "./cache-trace-sink.js";
export {
  createGguiConsumeHandler,
  type ConsumeLogger,
  type DrainAckNotifier,
  type GguiConsumeHandlerDeps,
  type ObserverNotifier,
} from "./consume.js";
export { ChannelNotDeclaredError, InvalidCompleteError, RenderNotFoundError } from "./errors.js";
export {
  clearGenerationCache,
  DEFAULT_CACHE_SIMILARITY_THRESHOLD,
  generationCacheKey,
  invalidateGenerationCache,
  listGenerationCache,
  type GenerationCacheDeps,
  type GenerationCacheEntry,
  type GenerationCacheHit,
} from "./generation-cache.js";
export {
  createGguiGetRenderHandler,
  type GetRenderHeartbeatResult,
  type GguiGetRenderHandlerDeps,
} from "./get-render.js";
export {
  handleStream,
  type HandleStreamDeps,
  type HandleStreamEnvelope,
  type RenderStreamTarget,
  type SendEnvelopeFn,
  type SendEnvelopeResult,
} from "./handle-stream.js";
export {
  createGguiListRendersHandler,
  type GguiListRendersHandlerDeps,
  type RenderSummaryWire,
} from "./list-renders.js";
export {
  buildNoCredentialsRender,
  NO_CREDENTIALS_SYSTEM_CARD_KIND,
} from "./no-credentials-card.js";
export {
  emitPayloadTraceEvent,
  getPayloadTraceSink,
  newPayloadTraceId,
  setPayloadTraceSink,
  type PayloadTraceDirection,
  type PayloadTraceEvent,
  type PayloadTraceSink,
} from "./payload-trace-sink.js";
export {
  createGguiRefreshWsTokenHandler,
  type GguiRefreshWsTokenHandlerDeps,
  type WsTokenRefreshSeam,
} from "./refresh-ws-token.js";
export {
  createGguiRenderHandler,
  type ChannelNotifier,
  type GenerationCredentials,
  type GenerationDeps,
  type GguiRenderHandlerDeps,
  type RenderPostSuccessArgs,
} from "./render.js";
export {
  applyRecordOp,
  DEFAULT_REPLAY_MAX_PER_RENDER,
  DEFAULT_REPLAY_MAX_RETRIES,
  EMPTY_BUFFER_STATE,
  normalizeBufferState,
  ReplayConflictError,
  replayFromBufferOp,
  ReplayMaxRetriesExceededError,
  ReplayRenderNotFoundError,
  runSequencedRecord,
  type ApplyRecordResult,
  type BufferedReplayEnvelope,
  type BufferState,
  type FetchedReplayState,
  type ReplayResult,
  type ReplaySequencerDeps,
  type RunSequencedRecordOptions,
  type StreamReplayInput,
} from "./stream-replay-ops.js";
export {
  createGguiEmitHandler,
  type GguiEmitHandlerDeps,
  type StreamObserverNotifier,
} from "./stream.js";
export { createGguiSubmitActionHandler } from "./submit-action.js";
export {
  createGguiSyncContextHandler,
  type CreateGguiSyncContextHandlerDeps,
} from "./sync-context.js";
export {
  createGguiUpdateHandler,
  UpdateUnsupportedError,
  type BillingGate,
  type GguiUpdateHandlerDeps,
  type PropsUpdateNotifier,
} from "./update.js";
// The handshake handler owns suggestion orchestration directly, via
// `HandshakeNegotiator.decide` returning a `HandshakeSuggestion`.
// The LLM-backed negotiator in `@ggui-ai/mcp-server` is the
// reference implementation.
export {
  matchBlueprint,
  type BlueprintMatchHit,
  type BlueprintMatchMiss,
  type BlueprintMatchResult,
  type MatchBlueprintDeps,
  type MatchBlueprintOptions,
} from "./blueprint-matcher.js";
export {
  BlueprintRejectedError,
  composeBlueprintId,
  composeEmbeddingInput,
  deleteBlueprint,
  findBlueprintExact,
  findBlueprintsByEmbedding,
  listBlueprints,
  recordBlueprintHit,
  registerBlueprint,
  type Blueprint,
  type BlueprintCandidate,
  type BlueprintKind,
  type BlueprintProvenance,
  type BlueprintRegistryDeps,
  type ContractValidator,
  type RegisterBlueprintInput,
  type RegisterBlueprintOptions,
} from "./blueprint-registry.js";
export {
  consumeHandshakeRecord,
  createGguiHandshakeHandler,
  DEFAULT_GENERATOR_SLUG,
  HANDSHAKE_RECORD_TTL_SEC,
  HandshakeNotFoundError,
  handshakeRecordKey,
  peekHandshakeRecord,
  type GguiHandshakeHandlerDeps,
  type HandshakeNegotiator,
  type HandshakeNegotiatorResult,
  type HandshakeRecord,
  type HandshakeStoredInput,
  type HandshakeStoredTarget,
} from "./handshake.js";
export { installToCache, type InstallToCacheInput } from "./install-to-cache.js";
export {
  createInstalledBlueprintsProvider,
  type CreateInstalledBlueprintsProviderOptions,
  type InstalledBlueprintCacheIssue,
  type CompileResult as InstalledBlueprintCompileResult,
  type InstalledBlueprintEntry,
  type InstalledBlueprintsProvider,
} from "./installed-blueprints-provider.js";
export {
  createInMemoryProvisionalPreviewRegistry,
  evaluateProvisionalPreviewGate,
  finalizeProvisionalPreview,
  kickoffProvisionalPreview,
  PreviewAbortError,
  PROVISIONAL_PREVIEW_CHANNEL,
  runProvisionalPreview,
  type ProvisionalPreviewConfig,
  type ProvisionalPreviewContext,
  type ProvisionalPreviewDeps,
  type ProvisionalPreviewEmit,
  type ProvisionalPreviewEmitter,
  type ProvisionalPreviewGate,
  type ProvisionalPreviewGateInput,
  type ProvisionalPreviewHandle,
  type ProvisionalPreviewOutcome,
  type ProvisionalPreviewRegistry,
  type ProvisionalPreviewRunContext,
  type ProvisionalPreviewSkipReason,
} from "./provisional-preview.js";

// Slice-meta projection helpers shared by the
// `_meta["ai.ggui/render"]` builder in `render.ts` / `update.ts`.
// Exported so any server can run the same projections off the
// resolved render without duplicating the actionSpec / contextSpec
// walks.
export {
  deriveBundleOrigins,
  deriveContextSlots,
  deriveContractBundle,
  derivePropsJson,
  derivePublicEnvProjection,
  deriveRenderMeta,
  deriveWiredActionTools,
  resolveGadgetUrls,
  type RenderMetaView,
} from "./slice-meta-derivation.js";
