/**
 * Host Context — projected subset of `McpUiHostContext` ggui captures from
 * the MCP Apps `ui/initialize` response and echoes back to render state so
 * the agent can reason about device/host capabilities on subsequent turns.
 *
 * The MCP Apps spec (`@modelcontextprotocol/ext-apps`) defines a rich
 * {@link McpUiHostContext} (theme, styles, displayMode, availableDisplayModes,
 * containerDimensions, locale, timeZone, userAgent, platform,
 * deviceCapabilities). ggui captures it iframe-side at `ui/initialize` and
 * echoes a TRIMMED projection back over the live channel (via the
 * `host_context_observed` outbound message) so the server can persist it on
 * `RenderRecord.hostContext` and surface it on `ggui_handshake` /
 * `ggui_consume` output for the agent.
 *
 * Why a projection rather than passthrough:
 *
 *   - `theme` / `styles` already flow through ggui's separate theming
 *     pipeline (`InterfaceContext` + the theme registry). Duplicating
 *     creates two sources of truth.
 *   - `toolInfo` is host-loop-internal — the agent has its own toolInfo via
 *     MCP framing.
 *   - `userAgent` is rarely actionable; skip until a concrete use case
 *     appears. Easy to add later (additive optional field).
 *
 * What the projection KEEPS:
 *
 *   - `availableDisplayModes` / `currentDisplayMode` — drives canvas-mode
 *     display-mode escalation policy (see canvas-mode-detail-displaymode.md).
 *   - `containerDimensions` — lets the agent reason about layout density
 *     and lets the canvas reflow on resize.
 *   - `platform` / `deviceCapabilities` — feeds the generator's
 *     responsive-UI prompts.
 *   - `locale` / `timeZone` — useful for the agent's date/number rendering.
 *
 * Compatibility posture: every field is optional. Hosts that emit a
 * minimal `McpUiHostContext` (spec-permissible) project to an empty
 * object; consumers MUST handle every field as possibly absent.
 *
 * Versioning: the wire wrapper carries `schemaVersion` so future
 * projection widenings can be detected; this module is the canonical
 * shape for the current schema major.
 */

import type { JsonValue } from './data-contract';

// =============================================================================
// Spec types — re-exported from `@modelcontextprotocol/ext-apps`.
//
// The protocol package owns ggui's TRIMMED projection
// ({@link HostContextProjection}); it re-exports the raw spec types
// {@link McpUiDisplayMode} / {@link McpUiHostContext} /
// {@link McpUiHostCapabilities} so downstream consumers (iframe-runtime,
// cloud, etc.) can import them through one path without each pulling a
// direct dep on the SDK. Re-exporting (not re-declaring) is the
// drift-proof posture — when the spec widens a literal or adds a field,
// every consumer sees it the next time the SDK version bumps. Pre-1.19b
// this module re-declared `McpUiDisplayMode` to keep the protocol
// package SDK-free; the SDK is small and tree-shakes cleanly on the
// type-only path, so the dep is worth the structural guarantee.
// =============================================================================

export type {
  McpUiDisplayMode,
  McpUiHostContext,
  McpUiHostCapabilities,
} from '@modelcontextprotocol/ext-apps';

import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps';

// =============================================================================
// Container dimensions (mirror of `McpUiHostContext.containerDimensions`)
// =============================================================================

/**
 * Width specification — either fixed `width` or `maxWidth`, never both.
 * Matches the spec's discriminated container-dimension shape.
 */
export interface HostContextWidth {
  readonly width?: number;
  readonly maxWidth?: number;
}

/**
 * Height specification — either fixed `height` or `maxHeight`, never both.
 */
export interface HostContextHeight {
  readonly height?: number;
  readonly maxHeight?: number;
}

/**
 * Iframe / container dimensions reported by the host. Width and height
 * are independently spec'd (one may be fixed, the other max-bounded).
 */
export type HostContextContainerDimensions = HostContextWidth & HostContextHeight;

// =============================================================================
// Device capabilities (mirror of `McpUiHostContext.deviceCapabilities`)
// =============================================================================

/**
 * Input capabilities reported by the host. Both `touch` and `hover` may
 * be true (hybrid devices); both may be false (rare, e.g., voice-only
 * hosts).
 */
export interface HostContextDeviceCapabilities {
  readonly touch?: boolean;
  readonly hover?: boolean;
}

// =============================================================================
// HostContextProjection — what ggui keeps + echoes
// =============================================================================

/**
 * Trimmed projection of `McpUiHostContext` that ggui captures iframe-side
 * and echoes to render state for agent visibility.
 *
 * Every field is optional. Hosts that emit minimal context project to
 * mostly-empty objects; consumers MUST treat every field as possibly
 * absent and degrade gracefully.
 *
 * Theme + styles intentionally EXCLUDED — they flow through ggui's own
 * theming pipeline (`InterfaceContext`, theme registry). Duplicating
 * here would create two sources of truth.
 *
 * `userAgent` + `toolInfo` intentionally EXCLUDED for v1 — easy to add
 * later if a concrete use case appears.
 */
export interface HostContextProjection {
  /** Display modes the host can render this view in. Absent ⇒ assume `['inline']`. */
  readonly availableDisplayModes?: readonly McpUiDisplayMode[];
  /** Current display mode the host is rendering. Absent ⇒ assume `'inline'`. */
  readonly currentDisplayMode?: McpUiDisplayMode;
  /** Iframe container dimensions. Absent ⇒ unknown; use a reasonable default. */
  readonly containerDimensions?: HostContextContainerDimensions;
  /** Host platform classification. */
  readonly platform?: 'web' | 'desktop' | 'mobile';
  /** Touch / hover input capability. */
  readonly deviceCapabilities?: HostContextDeviceCapabilities;
  /** User's BCP-47 locale (e.g., `'en-US'`). */
  readonly locale?: string;
  /** User's IANA timezone (e.g., `'America/Los_Angeles'`). */
  readonly timeZone?: string;
}

// =============================================================================
// Wire envelope (carried by the `host_context_observed` WebSocketMessage)
// =============================================================================

/**
 * Live-channel inbound (client → server) payload that delivers the
 * iframe-captured `HostContextProjection` to the server. Server-side
 * handler writes to `RenderRecord.hostContext`; subsequent
 * `ggui_handshake` / `ggui_consume` responses surface the value to the
 * agent via the optional `client.hostContext` field.
 *
 * Emission cadence:
 *   - Once after the iframe-runtime's `ui/initialize` resolves (initial
 *     capture).
 *   - Once per `ui/notifications/host-context-changed` notification
 *     received from the host.
 *
 * Idempotent — re-delivery (e.g., after a reconnect) overwrites the
 * stored value; no merge logic.
 */
export interface HostContextObservedPayload {
  readonly sessionId: string;
  readonly hostContext: HostContextProjection;
}

// =============================================================================
// Projection helper
// =============================================================================

/**
 * Type guard — `value` is a non-null, non-array plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True iff `value` is a valid `McpUiDisplayMode` literal.
 */
function isDisplayMode(value: unknown): value is McpUiDisplayMode {
  return value === 'inline' || value === 'fullscreen' || value === 'pip';
}

/**
 * Project a raw `McpUiHostContext` (from the spec SDK or any equivalent
 * shape — accepts `unknown` so callers don't need to drag in the SDK
 * just to call this) into `HostContextProjection`.
 *
 * Defensive: every field crosses a trust boundary. Malformed inputs
 * (wrong types, weird shapes) drop silently to undefined for that
 * field rather than failing the whole projection. The whole capture
 * path is best-effort — never blocks the bootstrap.
 *
 * Returns `undefined` when the input is not an object at all (caller
 * received null / array / primitive from the host). Returns an empty
 * object when the input is an object but no recognized fields are
 * present — the distinction lets callers tell "host emitted context
 * with no recognized fields" from "host emitted no context."
 */
export function projectHostContext(raw: unknown): HostContextProjection | undefined {
  if (!isPlainObject(raw)) return undefined;

  const out: {
    -readonly [K in keyof HostContextProjection]: HostContextProjection[K];
  } = {};

  // displayMode
  if (isDisplayMode(raw.displayMode)) {
    out.currentDisplayMode = raw.displayMode;
  }

  // availableDisplayModes
  if (Array.isArray(raw.availableDisplayModes)) {
    const filtered = raw.availableDisplayModes.filter(isDisplayMode);
    if (filtered.length > 0) out.availableDisplayModes = filtered;
  }

  // containerDimensions
  if (isPlainObject(raw.containerDimensions)) {
    const dims: { -readonly [K in keyof HostContextContainerDimensions]: HostContextContainerDimensions[K] } = {};
    const cd = raw.containerDimensions;
    if (typeof cd.width === 'number') dims.width = cd.width;
    if (typeof cd.maxWidth === 'number') dims.maxWidth = cd.maxWidth;
    if (typeof cd.height === 'number') dims.height = cd.height;
    if (typeof cd.maxHeight === 'number') dims.maxHeight = cd.maxHeight;
    if (Object.keys(dims).length > 0) out.containerDimensions = dims;
  }

  // platform
  if (raw.platform === 'web' || raw.platform === 'desktop' || raw.platform === 'mobile') {
    out.platform = raw.platform;
  }

  // deviceCapabilities
  if (isPlainObject(raw.deviceCapabilities)) {
    const dc: { -readonly [K in keyof HostContextDeviceCapabilities]: HostContextDeviceCapabilities[K] } = {};
    const src = raw.deviceCapabilities;
    if (typeof src.touch === 'boolean') dc.touch = src.touch;
    if (typeof src.hover === 'boolean') dc.hover = src.hover;
    if (Object.keys(dc).length > 0) out.deviceCapabilities = dc;
  }

  // locale
  if (typeof raw.locale === 'string' && raw.locale.length > 0) {
    out.locale = raw.locale;
  }

  // timeZone
  if (typeof raw.timeZone === 'string' && raw.timeZone.length > 0) {
    out.timeZone = raw.timeZone;
  }

  return out;
}

/**
 * Deep equality check for two projections. Used by the iframe-runtime
 * to suppress no-op re-emissions when a `host-context-changed`
 * notification arrives but no projection-visible field actually changed.
 *
 * JSON-stringify is sufficient because the projection contains only
 * primitives, arrays of primitives, and plain objects of primitives.
 */
export function hostContextProjectionsEqual(
  a: HostContextProjection | undefined,
  b: HostContextProjection | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Re-export JsonValue so consumers don't need to chase the import.
export type { JsonValue };
