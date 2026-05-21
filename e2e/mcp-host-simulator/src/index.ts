/**
 * `@ggui-ai/e2e-mcp-host-simulator` — Tier 2 testing fixture
 * for the OSS-local path.
 *
 * Public API:
 *   - {@link HostSimulator} — driver class for the App-spec lifecycle
 *     (initialize → tools/list with resourceUri pre-fetch → tools/call
 *     → ws subscribe). Shared core, also re-exported by
 *     `@ggui-private/e2e-host-simulator-remote` for remote tests.
 *   - {@link bootOssServer} — vitest helper that spins up an OSS
 *     `createGguiServer` factory on an ephemeral port for in-process
 *     testing. Tests targeting `mcp.ggui.ai` live in the cloud
 *     package and pass the remote URL into `HostSimulator` directly.
 *
 * Cloud/remote-only helpers (`loadAmplifyOutputs`) live in the
 * `@ggui-private/e2e-host-simulator-remote` package.
 *
 * See `README.md` for tier mapping + roadmap.
 */
export {
  HostSimulator,
  type HostSimulatorOptions,
  type CallToolResult,
  type SubscribeAck,
  type SimulateWiredActionArgs,
  type SimulateWiredActionResult,
  type HandshakeOutput,
  type HandshakeSuggestionView,
  type SuggestionBlueprintMeta,
  type PushDecisionInput,
} from './host-simulator.js';
export { bootOssServer, type OssFixture } from './boot-oss.js';
export {
  buildWiredAction,
  wiredActionFnv1a,
  formatWiredActionDataInline,
  type BuildWiredActionArgs,
  type BuiltWiredAction,
  type WiredActionToolsCallEnvelope,
  type WiredActionUpdateContextEnvelope,
  type WiredActionUiMessageEnvelope,
} from './wired-action.js';
export {
  OAuthFlowSimulator,
  generatePkcePair,
  type OAuthFlowSimulatorOptions,
  type ProtectedResourceMetadata,
  type AuthorizationServerMetadata,
  type DcrResponse,
  type PkcePair,
  type AuthorizeResult,
  type TokenResult,
  type RegisterArgs,
  type SubmitAuthorizeArgs,
  type ExchangeTokenArgs,
  type RunFullFlowArgs,
  type RunFullFlowResult,
} from './oauth-flow.js';
export {
  claudeAiShape,
  claudeDesktopShape,
  gooseShape,
  ALL_HOST_SHAPES,
  type HostShape,
  type HostShapeName,
} from './host-shapes.js';
