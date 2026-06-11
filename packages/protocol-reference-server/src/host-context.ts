/**
 * Inbound `host_context_observed` frame handling — parse the canonical
 * Client→Server observation message and persist its
 * `HostContextProjection` onto the named GguiSession.
 *
 * Obligation (mirrors the first-party `@ggui-ai/mcp-server` channel
 * handler): the message is fire-and-forget — NO response frame — and
 * the server persists `payload.hostContext` onto
 * `GguiSession.hostContext` as an idempotent overwrite (no merge), so
 * later agent-facing reads (`ggui_handshake` / `ggui_consume` in a
 * full server) surface the host's capabilities. The conformance kit
 * grades exactly this persistence: the `host-context-observed-persists`
 * fixture reads the field back via
 * `ConformanceHost.readSessionField('hostContext')` after the
 * observation window and deep-equals it against the authored
 * projection.
 *
 * Trust boundary: the frame crosses the wire, so every field is
 * re-validated against the protocol's `HostContextProjection` shape
 * (`@ggui-ai/protocol`, `types/host-context`) before anything is
 * persisted. Malformed frames — wrong payload shape, mistyped fields,
 * keys outside the projection vocabulary (e.g. `theme`, which flows
 * through ggui's theming pipeline, never host context) — drop
 * silently, matching this server's posture for malformed `action`
 * frames (`parseActionFrame` returns `undefined`). A dropped frame
 * persists NOTHING: a partial write from half-valid input would
 * fabricate state the client never coherently observed.
 *
 * Tenancy note: the first-party handler scopes the write through its
 * subscriber binding (`NOT_SUBSCRIBED` / `SESSION_MISMATCH` error
 * frames). The reference server has no auth identity by design
 * (accepts any bearer), so its tenancy scope is the render lookup
 * itself — the caller drops frames whose `payload.sessionId` names an
 * unknown render, mirroring the action path's unknown-render posture.
 */
import type {
  HostContextObservedPayload,
  HostContextProjection,
  McpUiDisplayMode,
} from '@ggui-ai/protocol';

import { isRecord } from '@ggui-ai/protocol';
import type { GguiSession } from './render.js';

/**
 * One inbound `host_context_observed` message — the canonical wire
 * shape from `@ggui-ai/protocol` (`transport/websocket`):
 * `{type: 'host_context_observed', payload: {sessionId, hostContext},
 * requestId?}`.
 */
export interface IncomingHostContextObservedMessage {
  readonly type: 'host_context_observed';
  readonly requestId?: string;
  readonly payload: HostContextObservedPayload;
}

/**
 * Parse + validate an inbound `host_context_observed` frame. Returns
 * the normalized typed message on success, `undefined` on ANY
 * malformed input — the server drops malformed frames silently (same
 * posture as {@link parseActionFrame}); fire-and-forget messages have
 * no rejection channel a conformant client would be listening on.
 *
 * Validation is strict against the protocol type: every present
 * `hostContext` field must carry the projection's shape, and unknown
 * keys reject the whole frame.
 */
export function parseHostContextObservedFrame(
  frame: unknown,
): IncomingHostContextObservedMessage | undefined {
  if (!isRecord(frame)) return undefined;
  if (frame['type'] !== 'host_context_observed') return undefined;
  const requestId = frame['requestId'];
  if (requestId !== undefined && typeof requestId !== 'string') return undefined;
  const payload = frame['payload'];
  if (!isRecord(payload)) return undefined;
  const sessionId = payload['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  const hostContext = parseHostContextProjection(payload['hostContext']);
  if (hostContext === undefined) return undefined;
  return {
    type: 'host_context_observed',
    ...(requestId !== undefined ? { requestId } : {}),
    payload: { sessionId, hostContext },
  };
}

/**
 * Handle one parsed `host_context_observed` message: persist the
 * validated projection onto the render. Idempotent overwrite — the
 * protocol declares re-delivery (e.g. after a reconnect) replaces the
 * stored value with no merge logic. No response frame is emitted; the
 * obligation is purely stateful and is graded by the kit through the
 * `readSessionField('hostContext')` introspection seam.
 */
export function handleHostContextObserved(
  message: IncomingHostContextObservedMessage,
  render: GguiSession,
): void {
  render.hostContext = message.payload.hostContext;
}

/**
 * Validating narrower for the wire `hostContext` body against the live
 * `HostContextProjection` (`@ggui-ai/protocol`, `types/host-context`).
 * Every field is optional, so presence is never required — but a
 * present field MUST carry the projection's shape, and unknown keys
 * reject the value (returns `undefined`): a key outside the projection
 * is state no conformant server is obligated to hold, and persisting
 * it would require erasing the protocol type.
 */
function parseHostContextProjection(value: unknown): HostContextProjection | undefined {
  if (!isRecord(value)) return undefined;
  const out: { -readonly [K in keyof HostContextProjection]: HostContextProjection[K] } = {};
  for (const [key, field] of Object.entries(value)) {
    switch (key) {
      case 'availableDisplayModes': {
        if (!Array.isArray(field)) return undefined;
        const modes: McpUiDisplayMode[] = [];
        for (const item of field) {
          if (!isDisplayMode(item)) return undefined;
          modes.push(item);
        }
        out.availableDisplayModes = modes;
        break;
      }
      case 'currentDisplayMode': {
        if (!isDisplayMode(field)) return undefined;
        out.currentDisplayMode = field;
        break;
      }
      case 'containerDimensions': {
        if (!isRecord(field)) return undefined;
        const dims: {
          width?: number;
          maxWidth?: number;
          height?: number;
          maxHeight?: number;
        } = {};
        for (const [dimKey, dimValue] of Object.entries(field)) {
          if (
            dimKey !== 'width' &&
            dimKey !== 'maxWidth' &&
            dimKey !== 'height' &&
            dimKey !== 'maxHeight'
          ) {
            return undefined;
          }
          if (typeof dimValue !== 'number') return undefined;
          dims[dimKey] = dimValue;
        }
        out.containerDimensions = dims;
        break;
      }
      case 'platform': {
        if (field !== 'web' && field !== 'desktop' && field !== 'mobile') {
          return undefined;
        }
        out.platform = field;
        break;
      }
      case 'deviceCapabilities': {
        if (!isRecord(field)) return undefined;
        const caps: { touch?: boolean; hover?: boolean } = {};
        for (const [capKey, capValue] of Object.entries(field)) {
          if (capKey !== 'touch' && capKey !== 'hover') return undefined;
          if (typeof capValue !== 'boolean') return undefined;
          caps[capKey] = capValue;
        }
        out.deviceCapabilities = caps;
        break;
      }
      case 'locale': {
        if (typeof field !== 'string' || field.length === 0) return undefined;
        out.locale = field;
        break;
      }
      case 'timeZone': {
        if (typeof field !== 'string' || field.length === 0) return undefined;
        out.timeZone = field;
        break;
      }
      default:
        return undefined;
    }
  }
  return out;
}

function isDisplayMode(value: unknown): value is McpUiDisplayMode {
  return value === 'inline' || value === 'fullscreen' || value === 'pip';
}
