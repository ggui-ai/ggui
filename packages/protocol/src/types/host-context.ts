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
 * `GguiSession.hostContext` and surface it on `ggui_handshake` /
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
 *   - `availableDisplayModes` / `currentDisplayMode` — drives the
 *     display-mode escalation policy (MCP Apps inline/fullscreen/pip).
 *   - `containerDimensions` — lets the agent reason about layout density
 *     and lets the rendered UI reflow on resize.
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
// The spec's display-mode vocabulary — DECLARED here, pinned equal to
// `@modelcontextprotocol/ext-apps` (ggui#847).
//
// The protocol package owns ggui's TRIMMED projection
// ({@link HostContextProjection}). From 1.19b to ggui#847 this module
// RE-EXPORTED the raw spec types (`McpUiDisplayMode`, `McpUiHostContext`,
// `McpUiHostCapabilities`) from ext-apps, so a consumer could import them
// through one path and a spec widening reached every consumer at the next
// dependency bump. That posture is reversed here, deliberately: ext-apps
// 1.x ships extensionless relative specifiers in its own `.d.ts`, so any
// declaration of ours that referenced it made a NodeNext consumer of
// `@ggui-ai/protocol` with `skipLibCheck: false` red on OUR line (four
// TS2305/TS2460 cascades, ggui#847) — and the only shape of ours that
// protocol itself reads is the display-mode vocabulary. So:
//
//   - `McpUiDisplayMode` is declared below, and `host-context.test-d.ts`
//     holds it EQUAL (not merely assignable) to ext-apps' type, so a
//     widening of the spec's vocabulary is a compile error at the next
//     bump, never a silent drift — the drift guarantee the re-export gave,
//     without the dependency.
//   - `McpUiHostContext` / `McpUiHostCapabilities` are no longer
//     re-exported: protocol never read them, and every consumer that does
//     (iframe-runtime, the host helpers) already imports them from ext-apps.
//   - `@modelcontextprotocol/ext-apps` is a devDependency of this package
//     (the pin), not a dependency: a NodeNext consumer of protocol alone no
//     longer loads ext-apps' declarations at all.
//
// EXIT CONDITION: the re-export returns when this package can depend on an
// ext-apps whose declarations resolve under NodeNext — ext-apps 2.x, which
// moves to the MCP SDK 2.0 split packages and is its own row.
// =============================================================================

/**
 * The MCP Apps display modes (`McpUiDisplayMode` in
 * `@modelcontextprotocol/ext-apps`), declared here and pinned equal to the
 * spec's type in `host-context.test-d.ts` (ggui#847, see above).
 */
export type McpUiDisplayMode = 'inline' | 'fullscreen' | 'pip';

import type { z } from 'zod';
import type { hostContextProjectionSchema, mcpUiDisplayModeSchema } from '../schemas/mcp';
import type { DeepReadonly } from './readonly';

/**
 * The wire enum is assignable to {@link McpUiDisplayMode} — checked at
 * compile time, so a display mode the spec adds (which the test-d pin
 * surfaces at the next ext-apps bump) is a protocol change here, never a
 * silent widening.
 */
export type HostContextDisplayModeIsExtApps =
  z.infer<typeof mcpUiDisplayModeSchema> extends McpUiDisplayMode ? true : never;

/**
 * Forces the check above to be EVALUATED: a conditional type nobody consumes
 * is never checked, but a value annotated with it is — if the wire enum ever
 * drifts from ext-apps' `McpUiDisplayMode`, `true` stops being assignable to
 * `never` and this line is the compile error.
 */
export const HOST_CONTEXT_DISPLAY_MODE_IS_EXT_APPS: HostContextDisplayModeIsExtApps = true;

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
export type HostContextProjection = DeepReadonly<
  z.infer<typeof hostContextProjectionSchema>
>;

// =============================================================================
// Wire envelope (carried by the `host_context_observed` WebSocketMessage)
// =============================================================================

/**
 * Live-channel inbound (client → server) payload that delivers the
 * iframe-captured `HostContextProjection` to the server. Server-side
 * handler writes to `GguiSession.hostContext`; subsequent
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
