/**
 * Shared session-mutation helpers. Centralizes the contract-enforcement
 * codepath so hosted + OSS mutation handlers converge on one set of
 * primitives.
 *
 * What's here today (pure + seam-free, depend only on `@ggui-ai/protocol`):
 *
 *   Payload-validation enforcement (schema-shape checks):
 *   - `assertPropsContract(spec, patch)` — validate props against a
 *     PropsSpec; throw `ContractViolationError{tool:'ggui_update'}` on
 *     violation. No-op when spec is absent.
 *   - `assertStreamContract(spec, data)` — same shape for streams.
 *     Used at BOTH inbound emit (ggui_emit) and outbound fan-out
 *     (handle-data pass-through) for defense-in-depth.
 *   - `assertActionContract(spec, value)` — same shape for inbound user
 *     actions (live-channel ingress).
 *
 *   Allowlist / subscription gating (access checks, distinct from schema):
 *   - `assertEventAllowed(subscription, eventType)` — reject inbound
 *     events whose type isn't in the active stack item's
 *     `subscription.events` allowlist. Throws `EventNotAllowedError`.
 *     Composes with `assertActionContract` at the ingress call-site:
 *     allowlist first, payload second.
 *
 *   Stack mutation flow:
 *   - `applyStackItemPatch({stack, stackItemId, patch})` — pure update flow:
 *     find the target item by `id`, enforce propsSpec, return a new
 *     stack. Throws `StackItemNotFoundError` when the target is missing.
 *
 *   Typed errors (each maps to a distinct enforcement concern):
 *   - `StackItemNotFoundError` — target stack item id is missing
 *   - `EventNotAllowedError` — event type not in the subscription allowlist
 *   - `ContractViolationError` (from `@ggui-ai/protocol`) — payload shape
 *     violates the declared schema. Re-exported implicitly via handler
 *     throw sites.
 *
 * What's NOT here yet — and why:
 *
 *   Full ggui_push / ggui_update / ggui_emit / ggui_consume handler
 *   bodies still live in the hosted pod. Extracting them requires new
 *   seams (`LiveDeliveryTransport` for WS fan-out, a hosted-shape
 *   SessionStore adapter, HandshakeStore abstraction, ObserverNotifier)
 *   — that's seam-widening to chase extraction. We wait for the seams
 *   to land on real need, not speculatively.
 *
 * The enforcement primitives above are the slice that matters today:
 *   every existing mutation path validate+throw'd inline, with each
 *   added callsite risking drift. Routing all those callsites through
 *   one helper file makes the enforcement codepath single.
 */
export {
  StackItemNotFoundError,
  EventNotAllowedError,
  NoActiveStackItemError,
  ChannelNotDeclaredError,
  InvalidCompleteError,
  SessionRequiredError,
  SessionNotFoundError,
  SessionClosedError,
} from './errors.js';
export { assertPropsContract } from './assert-props-contract.js';
export { assertStreamContract } from './assert-stream-contract.js';
export { assertActionContract } from './assert-action-contract.js';
export { assertEventAllowed } from './assert-event-allowed.js';
export {
  assertGadgetsRegistered,
  GadgetNotRegisteredError,
  GadgetPackageMismatchError,
  filterDescriptorsToContract,
  findClosestRegisteredHook,
  type UnregisteredHookEntry,
  type PackageMismatchEntry,
} from './assert-gadgets.js';
export {
  assertContractNoRetiredFields,
  ContractRetiredFieldError,
} from './assert-contract-no-retired-fields.js';
export {
  assertPublicEnvSatisfied,
  GadgetPublicEnvMissingError,
  findClosestPublicEnvKey,
  type PublicEnvViolation,
} from './assert-public-env.js';
export {
  applyStackItemPatch,
  type ApplyStackItemPatchInput,
  type ApplyStackItemPatchResult,
  type StackItemTarget,
} from './apply-stack-item-patch.js';
export {
  handleStream,
  type HandleStreamDeps,
  type HandleStreamEnvelope,
  type SendEnvelopeFn,
  type SendEnvelopeResult,
  type StreamSessionTarget,
} from './handle-stream.js';
export {
  applyRecordOp,
  replayFromBufferOp,
  normalizeBufferState,
  runSequencedRecord,
  EMPTY_BUFFER_STATE,
  DEFAULT_REPLAY_MAX_PER_SESSION,
  DEFAULT_REPLAY_MAX_RETRIES,
  ReplayConflictError,
  ReplayMaxRetriesExceededError,
  ReplaySessionNotFoundError,
  type ApplyRecordResult,
  type BufferedReplayEnvelope,
  type BufferState,
  type FetchedReplayState,
  type ReplayResult,
  type ReplaySequencerDeps,
  type RunSequencedRecordOptions,
  type StreamReplayInput,
} from './stream-replay-ops.js';
export {
  createGguiPushHandler,
  type ChannelNotifier,
  type GenerationCredentials,
  type GenerationDeps,
  type GguiPushHandlerDeps,
  type PushPostSuccessArgs,
} from './push.js';
export {
  NO_CREDENTIALS_SYSTEM_CARD_KIND,
  buildNoCredentialsStackItem,
} from './no-credentials-card.js';
export {
  createGguiUpdateHandler,
  UpdateUnsupportedError,
  type BillingGate,
  type GguiUpdateHandlerDeps,
  type PropsUpdateNotifier,
} from './update.js';
export {
  createGguiNewSessionHandler,
  type GguiNewSessionHandlerDeps,
} from './new-session.js';
export {
  createGguiConsumeHandler,
  type ConsumeLogger,
  type DrainAckNotifier,
  type GguiConsumeHandlerDeps,
  type ObserverNotifier,
} from './consume.js';
export {
  createGguiGetSessionHandler,
  type GetSessionHeartbeatResult,
  type GguiGetSessionHandlerDeps,
} from './get-session.js';
export {
  createGguiGetStackHandler,
  type GguiGetStackHandlerDeps,
} from './get-stack.js';
export {
  createGguiCloseHandler,
  type CloseObserverNotifier,
  type GguiCloseHandlerDeps,
} from './close.js';
export {
  createGguiPopHandler,
  type GguiPopHandlerDeps,
} from './pop.js';
export {
  createGguiEmitHandler,
  type GguiEmitHandlerDeps,
  type StreamObserverNotifier,
} from './stream.js';
export { createGguiSubmitActionHandler } from './submit-action.js';
export {
  createGguiRefreshBootstrapHandler,
  type BootstrapRefreshSeam,
  type GguiRefreshBootstrapHandlerDeps,
} from './refresh-bootstrap.js';
export {
  createGguiSyncContextHandler,
  type CreateGguiSyncContextHandlerDeps,
} from './sync-context.js';
export {
  clearGenerationCache,
  DEFAULT_CACHE_SIMILARITY_THRESHOLD,
  generationCacheKey,
  invalidateGenerationCache,
  listGenerationCache,
  type GenerationCacheDeps,
  type GenerationCacheEntry,
  type GenerationCacheHit,
} from './generation-cache.js';
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
} from './cache-trace-sink.js';
export {
  emitPayloadTraceEvent,
  getPayloadTraceSink,
  newPayloadTraceId,
  setPayloadTraceSink,
  type PayloadTraceDirection,
  type PayloadTraceEvent,
  type PayloadTraceSink,
} from './payload-trace-sink.js';
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
} from './blueprint-matcher.js';
export {
  registerBlueprint,
  findBlueprintExact,
  findBlueprintsByEmbedding,
  listBlueprints,
  recordBlueprintHit,
  deleteBlueprint,
  composeBlueprintId,
  composeEmbeddingInput,
  BlueprintRejectedError,
  type Blueprint,
  type BlueprintCandidate,
  type BlueprintKind,
  type BlueprintProvenance,
  type BlueprintRegistryDeps,
  type ContractValidator,
  type RegisterBlueprintInput,
  type RegisterBlueprintOptions,
} from './blueprint-registry.js';
export {
  installToCache,
  type InstallToCacheInput,
} from './install-to-cache.js';
export {
  createInstalledBlueprintsProvider,
  type CompileResult as InstalledBlueprintCompileResult,
  type CreateInstalledBlueprintsProviderOptions,
  type InstalledBlueprintCacheIssue,
  type InstalledBlueprintEntry,
  type InstalledBlueprintsProvider,
} from './installed-blueprints-provider.js';
export {
  createGguiHandshakeHandler,
  consumeHandshakeRecord,
  peekHandshakeRecord,
  handshakeRecordKey,
  HandshakeNotFoundError,
  HANDSHAKE_RECORD_TTL_SEC,
  DEFAULT_GENERATOR_SLUG,
  type GguiHandshakeHandlerDeps,
  type HandshakeNegotiator,
  type HandshakeNegotiatorResult,
  type HandshakeRecord,
  type HandshakeStoredInput,
  type HandshakeStoredTarget,
} from './handshake.js';
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
} from './provisional-preview.js';

// Bootstrap-meta projection helpers shared by the
// `_meta.ggui.bootstrap` builder in `push.ts` AND the public-render
// `/r/<shortCode>` route's self-contained-shell builder. Exported so
// any server can run the same projections off the active stack item
// without duplicating the actionSpec / contextSpec walks.
export {
  deriveBundleOrigins,
  deriveContextSlots,
  derivePropsJson,
  derivePublicEnvProjection,
  deriveStackItemBootstrapView,
  deriveWiredActionTools,
  resolveGadgetUrls,
  type StackItemBootstrapView,
} from './bootstrap-meta-derivation.js';
