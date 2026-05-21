/**
 * Re-export of the `@ggui-ai/protocol-conformance` fixture catalog.
 *
 * The fixture JSONs moved to `packages/protocol-conformance/src/fixtures/`
 * in Phase 3.1 commit 3 — this module now exists solely to keep
 * `mcp-app-iframe.spec.ts`'s import path stable. New code should
 * import from `@ggui-ai/protocol-conformance` directly.
 */
export { loadFixture, listFixtures, loadAllFixtures } from '@ggui-ai/protocol-conformance';
export type {
  // Core fixture shape
  TestCase,
  // Setup vocabulary
  SetupStep,
  CreateSessionStep,
  RegisterToolStep,
  EmitEnvelopeStep,
  SeedChannelStep,
  UnknownSetupStep,
  // Teardown vocabulary
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
} from '@ggui-ai/protocol-conformance';
