/**
 * `@ggui-ai/iframe-runtime` package entry — type-export surface for
 * non-iframe consumers (host apps, the `<McpAppIframe>` wrapper,
 * tests). The runtime artifact is `dist/iframe-runtime.js` (built by
 * `esbuild.config.mjs` from `src/runtime.ts`); this index does NOT
 * re-export the runtime side-effects.
 *
 * Surface:
 *   - `BootstrapParseFailureReason` — closed union of bootstrap-parse
 *     failure reasons.
 *   - `BootstrapParseResult` — discriminated union returned by
 *     `parseBootstrap()`.
 *   - `parseBootstrap` — the parser itself (consumers wanting to
 *     validate a bootstrap before spawning the iframe).
 *   - `RendererBootFailureReason` / `RendererBootFailedMessage` — the
 *     postMessage envelope shape parents observe on boot failure.
 *   - `ProtocolError` — canonical typed union for every failure
 *     the renderer classifies outward, wired to the postMessage
 *     envelope and the `_ggui:contract-error` WS channel.
 *   - `BootstrapFailureReason` — extensibly-closed union of every
 *     reason the 'bootstrap' variant can carry. Consolidates
 *     parse-time and post-parse codes in one place.
 *   - `ProtocolErrorEmitter` — function signature for the
 *     caller-side sink.
 *
 * Deliberately NOT exported: `RendererWebSocketManager`, `subscribe`,
 * `bootSequence`, `StackModel`. Those are the renderer's INTERNAL
 * runtime contract and should not become a load-bearing public API.
 */
export type {
  BootstrapParseFailureReason,
  BootstrapParseResult,
} from './types.js';
export {
  parseBootstrap,
  parseBootstrapFromUiInitialize,
  parseBootstrapFromGlobal,
  parseBootstrapFromToolResult,
  validateBootstrapMeta,
} from './bootstrap.js';
export type {
  RendererBootFailureReason,
  RendererBootFailedMessage,
  SelfContainedBootstrap,
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
