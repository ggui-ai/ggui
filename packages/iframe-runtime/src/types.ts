/**
 * Internal types shared across the `@ggui-ai/iframe-runtime` runtime.
 *
 * These shapes describe the renderer's INTERNAL contracts — the
 * slice-parse outcome union + the renderer-host postMessage frames.
 * The wire shapes consumed FROM the network (`SubscribePayload`,
 * `AckPayload`, `WebSocketMessage`, `McpAppAiGguiMeta`) come from
 * `@ggui-ai/protocol` and are imported as `type` only so esbuild
 * emits no runtime require for the protocol package — the bundle
 * stays self-contained.
 *
 * Post-B3b: the WS lifecycle lives inside `@ggui-ai/live-channel`'s
 * `WSTransport`; the renderer no longer maintains its own manager
 * class. The `RendererWebSocketManagerOptions` type that pre-B3b
 * declared the manager's constructor bag has been retired.
 */
import type {
  McpAppAiGguiMeta,
  McpAppAiGguiSessionMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { HostContextProjection } from '@ggui-ai/protocol';

/**
 * `McpAppAiGguiMeta` with the post-validation guarantee that `session`
 * is present. The wire type marks `session` optional (a delta envelope
 * can ship `stackItem` only); after {@link meta-parse.validateMeta} has
 * run, the absence of `session` would have surfaced as
 * `MISSING_META_GGUI_BOOTSTRAP` on the failure arm, so consumers of
 * the `ok: true` arm can read `meta.session` without an optional
 * chain.
 */
export type ValidatedMcpAppAiGguiMeta = Omit<McpAppAiGguiMeta, 'session'> & {
  readonly session: McpAppAiGguiSessionMeta;
};

// =============================================================================
// Slice parse — the typed result of reading the per-window meta keys
// (`ai.ggui/session`, `ai.ggui/stack-item`) off the host's
// `ui/initialize` response (or one of the other delivery envelopes).
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
 *     `_meta["ai.ggui/session"]` is absent. The on-wire synonym is
 *     `BOOTSTRAP_META_MISSING`. (Name retained pre-R4 for the
 *     observability + host-postMessage protocol; cosmetic rename is
 *     deferred.)
 *   - `MALFORMED_BOOTSTRAP` — slices are present but fail
 *     cross-slice business rules (no live mode and no static content,
 *     mismatched discriminators, or the combiner rejected one of the
 *     slice shapes structurally).
 *   - `EXPIRED_BOOTSTRAP` — `session.expiresAt` parses to a timestamp
 *     in the past AND there's no static stack-item to degrade to.
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
 * The `ok: true` arm carries the validated {@link McpAppAiGguiMeta}
 * pair (`session` always present post-validation; `stackItem`
 * optional for session-only refresh envelopes) and optionally a
 * `hostContext: HostContextProjection`. When the meta is extracted
 * from the `ui/initialize` response (Reading-A path), the parser
 * opportunistically projects the surrounding `McpUiHostContext`
 * into this field so the runtime can:
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
      readonly meta: ValidatedMcpAppAiGguiMeta;
      readonly hostContext?: HostContextProjection;
    }
  | {
      readonly ok: false;
      readonly reason: McpAppAiGguiMetaParseFailureReason;
    };

// `RendererWebSocketManagerOptions` retired in B3b — the WS lifecycle
// moved to `@ggui-ai/live-channel`'s `WSTransport`.
