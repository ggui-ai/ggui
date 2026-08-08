/**
 * What can the host we are embedded in actually do? (ggui#440)
 *
 * MCP Apps hosts advertise their capabilities on the `ui/initialize`
 * result. The `App` class captures them; this module is where the
 * runtime keeps that capture so the two decision points that care —
 * the gesture-failure explanation and the `ui/message` doorbell — can
 * consult one source instead of re-deriving it.
 *
 * FAIL-SAFE BY CONTRACT: absence of a capability MUST NOT stop the
 * runtime from attempting the operation. Hosts under-advertise in
 * practice — ggui's own embed host (`./mcp-app-iframe-host.ts`) proxies
 * `tools/call` while advertising nothing — so treating silence as
 * "cannot" would break working paths. These accessors exist to explain
 * a failure that already happened, never to pre-empt an attempt.
 *
 * PRESENCE, NOT VALUE: on `McpUiHostCapabilities` both fields are
 * optional OBJECTS (`serverTools?: { listChanged?: boolean }`,
 * `message?: McpUiSupportedContentBlockModalities`). An empty object is
 * a positive advertisement; `=== true` is never correct here.
 */
import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps";

let hostCapabilities: McpUiHostCapabilities | undefined;

/**
 * Has {@link setHostCapabilities} run yet? Distinct from "the host
 * advertised nothing" — before boot's `connectApp` resolves, this is
 * `false` AND `hostCanRelayToolCalls()` is `false`, which look
 * identical to a silent host unless a caller checks this too. A
 * gesture that fails in that mount-to-handshake window is a timing
 * artifact, not evidence about the host, so callers that latch on
 * confirmed incapability (ggui#440) MUST require this before trusting
 * capability absence.
 */
let captured = false;

/**
 * Record the host's advertised capabilities. Called once at boot, from
 * `bootSequence`, immediately after `connectApp` resolves — before that
 * point `App.getHostCapabilities()` returns `undefined`.
 */
export function setHostCapabilities(caps: McpUiHostCapabilities | undefined): void {
  hostCapabilities = caps;
  captured = true;
}

/**
 * Did the host advertise that it can proxy a guest `tools/call` to the
 * MCP server? `false` also covers "we have not connected yet" and "the
 * host advertised nothing" — callers must treat it as *unconfirmed*,
 * not as *impossible*.
 */
export function hostCanRelayToolCalls(): boolean {
  return hostCapabilities?.serverTools !== undefined;
}

/**
 * Did the host advertise that it accepts `ui/message` from the view?
 * This is the only view→host method that can start an agent turn, so a
 * host without it cannot be woken by the doorbell — the user has to
 * send a message themselves.
 */
export function hostCanReceiveMessages(): boolean {
  return hostCapabilities?.message !== undefined;
}

/**
 * Has the handshake resolved capabilities at all yet? See {@link captured}.
 * Callers that treat capability absence as confirmed incapability (as
 * opposed to merely unconfirmed) must gate on this first — otherwise
 * the pre-handshake window (where absence is just "not asked yet") is
 * indistinguishable from a host that answered and advertised nothing.
 */
export function hostCapabilitiesCaptured(): boolean {
  return captured;
}

/** @internal — exported for unit tests to reset module state. */
export function __resetHostCapabilitiesForTest(): void {
  hostCapabilities = undefined;
  captured = false;
}
