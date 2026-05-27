/**
 * Internal types shared across the `@ggui-ai/iframe-runtime` runtime.
 *
 * These shapes describe the renderer's INTERNAL contracts — the
 * slice-parse outcome union + the renderer-host postMessage frames.
 * The wire shapes consumed FROM the network (`SubscribePayload`,
 * `AckPayload`, `WebSocketMessage`, `McpAppAiGguiRenderMeta`) come from
 * `@ggui-ai/protocol` and are imported as `type` only so esbuild
 * emits no runtime require for the protocol package — the bundle
 * stays self-contained.
 *
 * Post-B3b: the WS lifecycle lives inside `@ggui-ai/live-channel`'s
 * `WSTransport`; the renderer no longer maintains its own manager
 * class. The `RendererWebSocketManagerOptions` type that pre-B3b
 * declared the manager's constructor bag has been retired.
 */
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { HostContextProjection } from '@ggui-ai/protocol';

/**
 * Post-Phase-B alias kept for ergonomic call sites — the wire-side
 * `McpAppAiGguiRenderMeta` is the single source of truth, and the
 * "validated" qualifier is a no-op now (no nested-optional-session
 * narrowing left after the slice merge). Future callers SHOULD prefer
 * `McpAppAiGguiRenderMeta` directly; the alias persists so the rename
 * sweep can land incrementally without churn at every call site.
 */
export type ValidatedMcpAppAiGguiMeta = McpAppAiGguiRenderMeta;

// =============================================================================
// Slice parse — the typed result of reading the per-window meta keys
// (`ai.ggui/render`) off the host's `ui/initialize` response (or one
// of the other delivery envelopes).
// =============================================================================

/**
 * Why a slice-meta parse can fail. Closed union — every value is a
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
 *     `_meta["ai.ggui/render"]` is absent. The on-wire synonym is
 *     `BOOTSTRAP_META_MISSING`. (Name retained pre-R4 for the
 *     observability + host-postMessage protocol; cosmetic rename is
 *     deferred.)
 *   - `MALFORMED_BOOTSTRAP` — slice is present but fails business
 *     rules (no live mode and no static content, mode discriminators
 *     mutually exclusive, structural rejection by the combiner).
 *   - `EXPIRED_BOOTSTRAP` — `expiresAt` parses to a timestamp in the
 *     past AND there's no static content to degrade to.
 */
export type McpAppAiGguiMetaParseFailureReason =
  | 'MISSING_TOOL_OUTPUT'
  | 'MISSING_META_GGUI_BOOTSTRAP'
  | 'MALFORMED_BOOTSTRAP'
  | 'EXPIRED_BOOTSTRAP';

/**
 * Result of a slice-meta extraction attempt. Discriminated on `ok`
 * so call sites get exhaustive narrowing without a typed-error class
 * — keeps the renderer's runtime cost tiny (no class metadata in the
 * bundle).
 *
 * The `ok: true` arm carries the validated {@link McpAppAiGguiRenderMeta}
 * slice and optionally a `hostContext: HostContextProjection`. When the
 * meta is extracted from the `ui/initialize` response (Reading-A path),
 * the parser opportunistically projects the surrounding
 * `McpUiHostContext` into this field so the runtime can:
 *   - drive canvas-mode display-mode escalation
 *   - echo to the server (live-channel `host_context_observed` envelope)
 *   - feed the agent on next handshake/consume
 *
 * Capture is best-effort: a malformed `HostContext` never blocks the
 * slice parse. Absent for the other extraction paths
 * (`__GGUI_META__` global, `ui/notifications/tool-result`) — those
 * envelopes don't carry HostContext.
 */
export type McpAppAiGguiMetaParseResult =
  | {
      readonly ok: true;
      readonly meta: McpAppAiGguiRenderMeta;
      readonly hostContext?: HostContextProjection;
    }
  | {
      readonly ok: false;
      readonly reason: McpAppAiGguiMetaParseFailureReason;
    };

// `RendererWebSocketManagerOptions` retired in B3b — the WS lifecycle
// moved to `@ggui-ai/live-channel`'s `WSTransport`.
