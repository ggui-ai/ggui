/**
 * Internal types shared across the `@ggui-ai/iframe-runtime` runtime.
 *
 * These shapes describe the renderer's INTERNAL contracts — the
 * bootstrap-parse outcome union + the renderer-host postMessage
 * frames. The wire shapes consumed FROM the network
 * (`SubscribePayload`, `AckPayload`, `WebSocketMessage`,
 * `GguiBootstrapMeta`) come from `@ggui-ai/protocol` and are imported
 * as `type` only so esbuild emits no runtime require for the protocol
 * package — the bundle stays self-contained.
 *
 * Post-B3b: the WS lifecycle lives inside `@ggui-ai/channel-client`'s
 * `WSTransport`; the renderer no longer maintains its own manager
 * class. The `RendererWebSocketManagerOptions` type that pre-B3b
 * declared the manager's constructor bag has been retired.
 */
import type { GguiBootstrapMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { HostContextProjection } from '@ggui-ai/protocol';

// =============================================================================
// Bootstrap parse — the typed result of reading `_meta.ggui.bootstrap`
// off the host's `ui/initialize` response.
// =============================================================================

/**
 * Why a bootstrap parse can fail. Closed union — every value is a
 * canonical reason the renderer surfaces to the host via postMessage.
 *
 * This set is intentionally narrow — it covers only parse-time
 * outcomes. Host-observable failures (`BUNDLE_FETCH_FAILED`,
 * `CSP_VIOLATION`, etc) live on the broader `BootstrapFailureReason`
 * union in `protocol-error.ts`. The four parse-time outcomes:
 *
 *   - `MISSING_TOOL_OUTPUT` — host echoed `ui/initialize` without a
 *     `result.toolOutput` object at all.
 *   - `MISSING_META_GGUI_BOOTSTRAP` — `result.toolOutput` exists but
 *     `_meta.ggui.bootstrap` is absent. The on-wire synonym is
 *     `BOOTSTRAP_META_MISSING`.
 *   - `MALFORMED_BOOTSTRAP` — `_meta.ggui.bootstrap` is present but
 *     missing one of the four required string fields (`wsUrl`,
 *     `token`, `sessionId`, `appId`) — i.e. it doesn't satisfy
 *     `GguiBootstrapMeta`.
 *   - `EXPIRED_BOOTSTRAP` — `expiresAt` is set and parses to a
 *     timestamp in the past. UX sugar; servers reject expired tokens
 *     anyway, but we skip the round-trip when the proof is on hand.
 */
export type BootstrapParseFailureReason =
  | 'MISSING_TOOL_OUTPUT'
  | 'MISSING_META_GGUI_BOOTSTRAP'
  | 'MALFORMED_BOOTSTRAP'
  | 'EXPIRED_BOOTSTRAP';

/**
 * Result of a bootstrap-meta extraction attempt. Discriminated on
 * `ok` so call sites get exhaustive narrowing without a typed-error
 * class — keeps the renderer's runtime cost tiny (no class metadata
 * in the bundle).
 *
 * widening: the `ok: true` arm now also carries
 * an optional `hostContext: HostContextProjection`. When the bootstrap
 * is extracted from the `ui/initialize` response (Reading-A path), the
 * parser opportunistically projects the surrounding `McpUiHostContext`
 * into this field so the runtime can:
 *   - drive canvas-mode display-mode escalation
 *   - echo to the server (live-channel `host_context_observed` envelope)
 *   - feed the agent on next handshake/consume
 *
 * Capture is best-effort: a malformed `HostContext` never blocks the
 * bootstrap parse. Absent for the other extraction paths
 * (`__GGUI_BOOTSTRAP__` global, `ui/notifications/tool-result`) — those
 * envelopes don't carry HostContext.
 */
export type BootstrapParseResult =
  | {
      readonly ok: true;
      readonly bootstrap: GguiBootstrapMeta;
      readonly hostContext?: HostContextProjection;
    }
  | { readonly ok: false; readonly reason: BootstrapParseFailureReason };

// `RendererWebSocketManagerOptions` retired in B3b — the WS lifecycle
// moved to `@ggui-ai/channel-client`'s `WSTransport`.
