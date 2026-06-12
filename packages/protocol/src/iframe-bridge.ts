/**
 * Event names used across the iframe bridge -- symmetric naming convention.
 *
 * Events prefixed with `ggui-` are `postMessage` types (cross-origin iframe boundary).
 * Events prefixed with `ggui:` are `CustomEvent` names (same-origin, dispatched on `window`).
 *
 * The bridge is one-directional: **Agent to Component** (inbound) data
 * deliveries. Outbound user interaction does NOT travel over this bridge —
 * generated components emit canonical `data:submit` ActionEnvelopes via the
 * wire-config action hooks (`useAction`) over the live channel.
 */
export const BRIDGE_EVENTS = {
  // === Agent → Component (inbound via ggui_emit) ===
  /** `postMessage` type for parent-to-iframe data delivery. The parent window posts this type; the iframe bridge script converts it to an `AGENT_DATA` CustomEvent. */
  AGENT_DATA_POST: 'ggui-agent-data',
  /** `CustomEvent` name dispatched on `window` when agent data arrives. Components listen for this to receive real-time data from the agent (chat messages, typing indicators, etc.). */
  AGENT_DATA: 'ggui:agent-data',
} as const;

/**
 * Srcdoc JS snippet: bridge agent data postMessages into CustomEvents inside iframe.
 * Inject this into any srcdoc <script> so that components receive ggui:agent-data
 * events when the parent forwards data via postMessage.
 */
export const SRCDOC_AGENT_DATA_BRIDGE = `
  window.addEventListener("message", function(event) {
    if (event.data && event.data.type === "ggui-agent-data") {
      window.dispatchEvent(new CustomEvent("ggui:agent-data", { detail: event.data.payload }));
    }
  });`;

