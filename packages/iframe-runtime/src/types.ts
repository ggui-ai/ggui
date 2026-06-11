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
import type {
  HostContextProjection,
  ComponentGguiSession,
  SystemGguiSession,
} from '@ggui-ai/protocol';

/**
 * The four server-assigned ledger fields on every wire-delivered
 * {@link GguiSession}. They're stamped by the server's per-render event
 * ledger — NOT derivable from the inline `__GGUI_META__` bootstrap.
 */
type GguiSessionLedgerFields =
  | 'eventSequence'
  | 'createdAt'
  | 'lastActivityAt'
  | 'expiresAt';

/**
 * The mount surface's INPUT contract — what `mountRender` / `applyRender`
 * accept. It is a {@link GguiSession} minus the four server-assigned ledger
 * fields ({@link GguiSessionLedgerFields}), so the runtime can mount the
 * compiled component (or system card) carried inline by the resource
 * shell BEFORE the authoritative wire `GguiSession` arrives over the WS.
 *
 * A full `GguiSession` is assignable to `GguiSessionSeedInput` (it carries every
 * field plus the ledger), so the WS-ack reconcile path passes a real
 * `GguiSession` here unchanged; the inline-seed path passes the projection
 * built by `buildGguiSessionSeedInput`. We do NOT fabricate the ledger fields
 * (Strict-Typing-First / no-type-laundering) — the first ack replaces
 * the seed with the authoritative `GguiSession`.
 *
 * Carries the SAME contract-spec fields a full `ComponentGguiSession` does
 * (`propsSpec` / `streamSpec` / `actionSpec`), as `undefined` on a
 * seed — so the channel handlers that read those after the
 * `type !== 'mcpApps' && type !== 'system'` narrowing stay type-clean.
 */
export type GguiSessionSeedInput =
  | Omit<ComponentGguiSession, GguiSessionLedgerFields>
  | Omit<SystemGguiSession, GguiSessionLedgerFields>;

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
 *   - `MISSING_TOOL_OUTPUT` — the tool-result notification's `params`
 *     was not an object (no `CallToolResult` to read). (Name predates
 *     the spec-canonical top-level `_meta` reading; retained for the
 *     observability + host-postMessage protocol — cosmetic rename is
 *     deferred.)
 *   - `MISSING_META_GGUI_BOOTSTRAP` — `params` is an object but
 *     `params._meta` is absent or carries no `ai.ggui/render` slice.
 *     The on-wire synonym is `BOOTSTRAP_META_MISSING`. (Name retained
 *     pre-R4 for the observability + host-postMessage protocol;
 *     cosmetic rename is deferred.)
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
 * slice and optionally a `hostContext: HostContextProjection`. The
 * producer is the boot path in `runtime.ts`, which projects
 * `app.getHostContext()` (the App class's spec-canonical
 * `ui/initialize` capture plus its `hostcontextchanged` listener)
 * into this field so the runtime can:
 *   - drive display-mode escalation (MCP Apps inline/fullscreen/pip)
 *   - echo to the server (live-channel `host_context_observed` envelope)
 *   - feed the agent on next handshake/consume
 *
 * Capture is best-effort: a malformed `HostContext` never blocks the
 * slice parse. The envelope extractors themselves (`__GGUI_META__`
 * global, `ui/notifications/tool-result`) never populate it — those
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
