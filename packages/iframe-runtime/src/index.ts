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
 *     the slice-meta extractors.
 *   - `parseMetaFromGlobal` / `parseMetaFromToolResult` — the two
 *     production extractors (consumers wanting to validate a slice
 *     meta before spawning the iframe).
 *   - `validateMeta` — the shared mode-discriminator + expiresAt
 *     validator the extractors funnel into.
 *   - `RendererBootFailureReason` / `RendererBootFailedMessage` — the
 *     postMessage envelope shape parents observe on boot failure.
 *   - `ProtocolError` — canonical typed union for every failure
 *     the renderer classifies outward, wired to the postMessage
 *     envelope.
 *   - `BootstrapFailureReason` — extensibly-closed union of every
 *     reason the 'bootstrap' variant can carry. Consolidates
 *     parse-time and post-parse codes in one place. (Wire-visible
 *     name; kept stable for host postMessage observers.)
 *   - `ProtocolErrorEmitter` — function signature for the
 *     caller-side sink.
 *
 * Deliberately NOT exported: `bootSequence`, `connectViaRegistry`, the
 * per-channel handler factories, and the single-item render mount.
 * Those are the renderer's INTERNAL runtime contract and should not
 * become a load-bearing public API.
 */
export type {
  McpAppAiGguiMetaParseFailureReason,
  McpAppAiGguiMetaParseResult,
} from './types.js';
export {
  parseMetaFromGlobal,
  parseMetaFromToolResult,
  validateMeta,
} from './meta-parse.js';
export type {
  RendererBootFailureReason,
  RendererBootFailedMessage,
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
  fromTransportFailure,
  fromAuthFailure,
  fromUpgradeRequired,
  fromUnknown,
} from './protocol-error.js';
export type {
  ObservabilityEvent,
  ObservabilityEmitter,
  ObservabilityMessage,
  SchemaVersionMismatchEvent,
  SubscribeFailedEvent,
  AuthRequiredEvent,
  ChannelTransportPickedEvent,
  ChannelTransportFallbackEvent,
  ChannelTransportResubscribedEvent,
  UnknownObservabilityEvent,
} from './observability.js';
export { postObservabilityToParent } from './observability.js';
export type { LifecycleEmitter } from './lifecycle.js';
export { postLifecycleToParent, makeLifecycleEvent } from './lifecycle.js';
