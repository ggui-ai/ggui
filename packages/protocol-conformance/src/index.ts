/**
 * `@ggui-ai/protocol-conformance` — conformance test kit for the
 * ggui protocol.
 *
 * Packages the fixture catalog as a consumable npm artifact, plus a
 * runner that drives each fixture against a live implementation over
 * WebSocket and reports a scorecard-style pass / fail / skip summary.
 *
 * The kit IS the protocol's conformance surface — any drift between
 * its assertions and `@ggui-ai/protocol`'s types is the canonical
 * bug.
 */

// Fixture authoring surface — the shape of every JSON case under
// `./fixtures/**` and the vocabulary third-party fixture authors
// compile against.
export type {
  // Transport
  TransportConfig,
  WebSocketTransportConfig,
  UnknownTransportConfig,
  AuthConfig,
  // Core fixture shape
  TestCase,
  SubscribeFrameShaping,
  // Setup vocabulary (JSON-authoring surface — closed union)
  SetupStep,
  CreateGguiSessionStep,
  ActionSpecEntryDecl,
  JsonSchemaDecl,
  RendererUrlOverrideStep,
  ServerVersionOverrideStep,
  UiInitializeResponseOverrideStep,
  EmitEnvelopeStep,
  // Teardown vocabulary (JSON-authoring surface — empty this version)
  TeardownStep,
  // Expected-behavior vocabulary
  ExpectedBehavior,
  ActionAckBehavior,
  ErrorFrameBehavior,
  StreamUpdateBehavior,
  BootstrapFailureBehavior,
  BootstrapSuccessBehavior,
  VersionMismatchBehavior,
  PropsUpdateBehavior,
  SessionStateBehavior,
  NoOpBehavior,
  UnknownBehavior,
  // Authored protocol vocabulary copies
  ProtocolError,
  BootstrapFailureReason,
} from './types.js';

// Conformance-host runtime surface — the adapter the implementation
// under test provides to the runner. Host directive unions here are
// the narrowed runtime form (parallel to `./types`' JSON-authoring
// form).
export type {
  ConformanceHost,
  // Setup directives (runtime surface — narrowed)
  SetupStep as HostSetupStep,
  CreateGguiSessionSetup,
  RendererUrlOverrideSetup,
  ServerVersionOverrideSetup,
  UiInitializeResponseOverrideSetup,
  EmitEnvelopeSetup,
  // Teardown directives (runtime surface — empty this version)
  TeardownStep as HostTeardownStep,
} from './conformance-host.js';

// Fixture catalog — every authored conformance case, classified by
// contract. Third-party runners + the kit's own `runConformance()`
// consume this surface.
export {
  allFixtures,
  fixturesByContract,
  bootstrapProtocolFixtures,
  consumeBufferFixtures,
  hostContextFixtures,
  reservedChannelAuthorityFixtures,
  schemaVersionHandshakeFixtures,
  subscribeTenancyFixtures,
} from './fixtures/index.js';
export type { ContractSlug } from './fixtures/index.js';

// Pure-function conformance catalogs — SPEC §7.7.2's gadget
// obligations are deterministic validation functions, not transport-
// observable behaviors. Each catalog grades a caller-supplied function
// against authored accept/reject cases; no host, render, or wire.
//
// Schema-conformance — which `DataContract.clientCapabilities`
// payloads a conformant parser MUST accept / reject.
export {
  gadgetWireSchemaCases,
  runSchemaConformance,
} from './schema-conformance/index.js';
export type {
  SchemaConformanceCase,
  SchemaConformanceMismatch,
  SchemaConformanceResult,
} from './schema-conformance/index.js';

// Props-schema conformance — the schema-precise render arbiter
// (frozen shape 2026-08-19): the enforced-schema builder, its RFC 8785
// hash, the grammar-safe profile, and returned-schema AUTHORITY, each
// graded against caller-supplied callbacks over a polyglot JSON
// catalog. Includes the live-incident enum sample.
export {
  propsSchemaConformanceCases,
  runPropsSchemaConformance,
} from './props-schema-conformance/index.js';
export type {
  PropsSchemaConformanceCase,
  PropsSchemaConformanceFailure,
  PropsSchemaConformanceReport,
  PropsSchemaConformanceSample,
  PropsSchemaImplementation,
} from './props-schema-conformance/index.js';

// Registration-conformance — which `(contract, appGadgets, appPublicEnv)`
// triples the push-time gadget gate stack MUST accept / reject, with
// which precise SPEC §7.9 reject code.
export {
  gadgetRegistrationCases,
  runRegistrationConformance,
} from './registration-conformance/index.js';
export type {
  GadgetGateRejectCode,
  GateOutcome,
  RegistrationConformanceCase,
  RegistrationConformanceMismatch,
  RegistrationConformanceResult,
} from './registration-conformance/index.js';

// Resolution-conformance — which bundle + style URLs the server MUST
// compute for a gadget descriptor's transport fields (`bundleHost`
// precedence, default host, loopback scheme).
export {
  gadgetResolutionCases,
  runResolutionConformance,
} from './resolution-conformance/index.js';
export type {
  GadgetUrlEntry,
  ResolvedGadgetUrls,
  ResolutionConformanceCase,
  ResolutionConformanceMismatch,
  ResolutionConformanceResult,
} from './resolution-conformance/index.js';

// Binding-conformance — MCP tool-binding resolution (declared wins,
// contract-lineage derivation, schema-invalid rejects) + the search
// filter semantics (`tool=` / `server=` case-sensitive exact,
// AND-composed per entry).
export {
  bindingFilterCases,
  bindingResolutionCases,
  runBindingFilterCases,
  runBindingResolutionCases,
} from './binding-conformance/index.js';
export type {
  BindingFilterCase,
  BindingFilterMismatch,
  BindingFilterResult,
  BindingManifestEntry,
  BindingRejectCode,
  BindingResolutionCase,
  BindingResolutionMismatch,
  BindingResolutionOutcome,
  BindingResolutionResult,
  McpToolBindingDecl,
  McpToolFilterDecl,
} from './binding-conformance/index.js';

// Refusal-envelope conformance — the tool result a server MUST emit for
// a PRE-GENERATION refusal (SPEC §7.1's refused arm): an in-result
// `isError`, the code leading the text, `{outcome, refusal}` and
// nothing else on structuredContent, no `_meta`, and no envelope at all
// for a code whose surfaces exclude the render gate.
export {
  refusalEnvelopeCases,
  runRefusalEnvelopeConformance,
} from './refusal-envelope-conformance/index.js';
export type {
  PreGenerationRefusalInput,
  ProjectedRefusalResult,
  RefusalEnvelopeConformanceCase,
  RefusalEnvelopeConformanceResult,
  RefusalEnvelopeMismatch,
} from './refusal-envelope-conformance/index.js';

// Registry-completeness — the structural obligations a deployment's
// closed refusal-code registry MUST satisfy. Grades DATA rather than a
// function: `surfaces` non-empty, `code === key`, every `after-fix`
// entry naming who acts, and `retry` inside the closed four-value set.
export {
  registryCompletenessPins,
  runRegistryCompletenessConformance,
} from './registry-completeness/index.js';
export type {
  RefusalRegistryRow,
  RefusalRegistryView,
  RegistryCompletenessMismatch,
  RegistryCompletenessPin,
  RegistryCompletenessResult,
} from './registry-completeness/index.js';

// Transport-refusal — the JSON-RPC error a per-app MCP endpoint answers
// with when it refuses a request for a typed reason (ggui#825): HTTP 403,
// `-32003` / `App not found` (ggui#836), `data.refusal` carrying the registry
// projection without the render-only fields; a code whose surfaces
// exclude `mcp-endpoint` projects to nothing.
export {
  runTransportRefusalConformance,
  transportRefusalCases,
} from './transport-refusal-conformance/index.js';
export type {
  ProjectedTransportRefusal,
  TransportRefusalConformanceCase,
  TransportRefusalConformanceResult,
  TransportRefusalInput,
  TransportRefusalMismatch,
} from './transport-refusal-conformance/index.js';

// Resource-read conformance — the kit's first MCP-binding driver, and
// it binds `resources/read` ONLY (`tools/call` has none). A read of a
// render locator has exactly two exits: a result whose contents
// declare a delivery channel, or one typed JSON-RPC error.
// Unlike the three catalogs above this one drives a live server, so
// the caller supplies a scenario driver rather than a pure function.
export {
  declaresDeliveryChannel,
  renderLocatorUri,
  resourceReadCases,
  runResourceReadConformance,
  GGUI_RENDER_RESOURCE_URI,
} from './resource-read-conformance/index.js';
export type {
  DurableSubstrateWiring,
  JsonRpcErrorFrame,
  PreparedResourceReadScenario,
  ResourceReadCaller,
  ResourceReadConformanceCase,
  ResourceReadConformanceFailure,
  ResourceReadConformanceResult,
  ResourceReadConformanceSkip,
  ResourceReadErrorCodeDecl,
  ResourceReadExpectation,
  ResourceReadKey,
  ResourceReadLocator,
  ResourceReadOutcome,
  ResourceReadProbe,
  ResourceReadRenderMeta,
  ResourceReadScenario,
  ResourceReadScenarioDriver,
  ResourceReadSeed,
  ResourceReadServerShape,
  RunResourceReadConformanceOptions,
} from './resource-read-conformance/index.js';

// Runtime loader — look up a fixture by name from the inlined catalog.
export { loadFixture, listFixtures, loadAllFixtures } from './loader.js';

// Runner — drive the catalog against a live implementation.
export { runConformance } from './run-conformance.js';
export type {
  RunConformanceConfig,
  ConformanceResult,
  ConformanceFailure,
  SkippedFixture,
  ConformanceReporter,
  // Closed input-envelope dispatch vocabulary — the C→S frame types a
  // fixture's `inputEnvelope` may author for explicit post-subscribe
  // dispatch.
  InputEnvelopeDispatch,
  HostContextObservedInputEnvelope,
} from './run-conformance.js';

// Default reporter — stdout-based bar-scorecard implementation +
// formatters programmatic consumers can reuse when building their
// own reporter (CI annotations, vitest integration, etc.).
export {
  createDefaultReporter,
  formatScorecard,
  formatSummary,
  formatFailures,
  formatSkips,
} from './reporter.js';
export type { DefaultReporterOptions } from './reporter.js';
