/**
 * `@ggui-ai/iframe-runtime` package entry — type-export surface for
 * non-iframe consumers (host apps, the `<McpAppIframe>` wrapper,
 * tests). The runtime artifact is `dist/iframe-runtime.js` (built by
 * `esbuild.config.mjs` from `src/runtime.ts`); this index does NOT
 * re-export the runtime side-effects.
 *
 * Surface:
 *   - `McpAppAiGguiMetaParseFailureReason` — closed union of slice-meta
 *     parse failure reasons.
 *   - `McpAppAiGguiMetaParseResult` — discriminated union returned by
 *     `parseMetaFromUiInitialize()`.
 *   - `parseMetaFromUiInitialize` — the parser itself (consumers
 *     wanting to validate a slice meta before spawning the iframe).
 *     Also exported as `parseBootstrap` for back-compat with pre-R4
 *     call sites.
 *   - `RendererBootFailureReason` / `RendererBootFailedMessage` — the
 *     postMessage envelope shape parents observe on boot failure.
 *   - `ProtocolError` — canonical typed union for every failure
 *     the renderer classifies outward, wired to the postMessage
 *     envelope and the `_ggui:contract-error` WS channel.
 *   - `BootstrapFailureReason` — extensibly-closed union of every
 *     reason the 'bootstrap' variant can carry. Consolidates
 *     parse-time and post-parse codes in one place. (Wire-visible
 *     name; kept stable for host postMessage observers.)
 *   - `ProtocolErrorEmitter` — function signature for the
 *     caller-side sink.
 *
 * Deliberately NOT exported: `RendererWebSocketManager`, `subscribe`,
 * `bootSequence`, `StackModel`. Those are the renderer's INTERNAL
 * runtime contract and should not become a load-bearing public API.
 */
export type {
  McpAppAiGguiMetaParseFailureReason,
  McpAppAiGguiMetaParseResult,
} from './types.js';
export {
  parseBootstrap,
  parseMetaFromUiInitialize,
  parseMetaFromGlobal,
  parseMetaFromToolResult,
  validateMeta,
} from './meta-parse.js';
export type {
  RendererBootFailureReason,
  RendererBootFailedMessage,
  SelfContainedMcpAppAiGguiMeta,
} from './runtime.js';
export type {
  ProtocolError,
  ProtocolErrorEmitter,
  BootstrapFailureReason,
} from './protocol-error.js';
export {
  defaultProtocolErrorEmitter,
  fromBootstrapFailure,
  fromClientContractViolation,
  fromContractErrorPayload,
  fromTransportFailure,
  fromAuthFailure,
  fromUpgradeRequired,
  fromUnknown,
} from './protocol-error.js';
export type {
  ObservabilityEvent,
  ObservabilityEmitter,
  ObservabilityMessage,
  WiredToolInvokedEvent,
  ContractErrorEmittedEvent,
  SchemaVersionMismatchEvent,
  SubscribeFailedEvent,
  AuthRequiredEvent,
  UnknownObservabilityEvent,
} from './observability.js';
export { postObservabilityToParent } from './observability.js';
export type { LifecycleEmitter } from './lifecycle.js';
export { postLifecycleToParent, makeLifecycleEvent } from './lifecycle.js';
