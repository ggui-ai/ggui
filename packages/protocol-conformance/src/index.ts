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
  // Setup vocabulary (JSON-authoring surface)
  SetupStep,
  CreateSessionStep,
  RegisterToolStep,
  EmitEnvelopeStep,
  SeedChannelStep,
  UnknownSetupStep,
  // Teardown vocabulary (JSON-authoring surface)
  TeardownStep,
  CloseSessionStep,
  UnregisterToolStep,
  UnknownTeardownStep,
  // Expected-behavior vocabulary
  ExpectedBehavior,
  ContractErrorBehavior,
  StreamUpdateBehavior,
  ObservabilityBehavior,
  BootstrapFailureBehavior,
  BootstrapSuccessBehavior,
  VersionMismatchBehavior,
  PropsUpdateBehavior,
  NoOpBehavior,
  UnknownBehavior,
  ExpectedObservabilityEvent,
  // Authored protocol vocabulary copies
  ProtocolError,
  BootstrapFailureReason,
  ContractErrorCode,
} from './types.js';

// Conformance-host runtime surface — the adapter the implementation
// under test provides to the runner. Host directive unions here are
// the narrowed runtime form (parallel to `./types`' JSON-authoring
// form).
export type {
  ConformanceHost,
  // Setup directives (runtime surface — narrowed)
  SetupStep as HostSetupStep,
  CreateSessionSetup,
  RegisterToolSetup,
  RegisterActionSpecSetup,
  EmitEnvelopeSetup,
  RendererUrlOverrideSetup,
  UiInitializeResponseOverrideSetup,
  ServerVersionOverrideSetup,
  UnknownSetupStep as HostUnknownSetupStep,
  // Teardown directives (runtime surface — narrowed)
  TeardownStep as HostTeardownStep,
  CloseSessionTeardown,
  UnregisterToolTeardown,
  UnknownTeardownStep as HostUnknownTeardownStep,
} from './conformance-host.js';

// Fixture catalog — every authored conformance case, classified by
// contract. Third-party runners + the kit's own `runConformance()`
// consume this surface.
export {
  allFixtures,
  fixturesByContract,
  bootstrapProtocolFixtures,
  canvasModeWireShapesFixtures,
  observabilityEventsFixtures,
  refreshSemanticsFixtures,
  reservedChannelAuthorityFixtures,
  schemaVersionHandshakeFixtures,
  wiredActionDispatchFixtures,
} from './fixtures/index.js';
export type { ContractSlug } from './fixtures/index.js';

// Pure-function conformance catalogs — SPEC §7.7.2's gadget
// obligations are deterministic validation functions, not transport-
// observable behaviors. Each catalog grades a caller-supplied function
// against authored accept/reject cases; no host, session, or wire.
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

// Registration-conformance — which `(contract, appGadgets)` pairs the
// push-time gadget registry gate MUST accept / reject, with which
// precise reject code.
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
