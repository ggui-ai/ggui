/**
 * `@ggui-ai/e2e-mcp-host-simulator` — Tier 2 testing fixture
 * for the OSS-local path.
 *
 * Public API:
 *   - {@link HostSimulator} — driver class for the App-spec lifecycle
 *     (initialize → tools/list with resourceUri pre-fetch → tools/call
 *     → ws subscribe). Transport-generic: pass any deployed ggui
 *     server's URL to drive the same lifecycle remotely.
 *   - {@link bootOssServer} — vitest helper that spins up an OSS
 *     `createGguiServer` factory on an ephemeral port for in-process
 *     testing. To test a remote deployment, skip the fixture and pass
 *     the server's URL into `HostSimulator` directly.
 *
 * See `README.md` for tier mapping + roadmap.
 */
export {
  HostSimulator,
  type HostSimulatorOptions,
  type CallToolResult,
  type SubscribeAck,
  type SimulateSubmitActionArgs,
  type SimulateSubmitActionResult,
  type HandshakeOutput,
  type HandshakeSuggestionView,
  type SuggestionBlueprintMeta,
  type RenderOverrideInput,
} from './host-simulator.js';
export { bootOssServer, type OssFixture } from './boot-oss.js';
export {
  buildSubmitAction,
  submitActionFnv1a,
  formatSubmitActionDataInline,
  type BuildSubmitActionArgs,
  type BuiltSubmitAction,
  type SubmitActionToolsCallEnvelope,
  type SubmitActionUpdateContextEnvelope,
  type SubmitActionUiMessageEnvelope,
} from './submit-action.js';
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
