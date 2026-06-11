/**
 * Event names used across the iframe bridge -- symmetric naming convention.
 *
 * Events prefixed with `ggui-` are `postMessage` types (cross-origin iframe boundary).
 * Events prefixed with `ggui:` are `CustomEvent` names (same-origin, dispatched on `window`).
 *
 * The bridge has three directions:
 * 1. **Agent to Component** (inbound): data deliveries
 * 2. **Component to Agent** (outbound): user interactions (form submits, clicks)
 * 3. **Component to Host** (outbound): rendering lifecycle (resize, success, error)
 */
export const BRIDGE_EVENTS = {
  // === Agent → Component (inbound via ggui_emit) ===
  /** `postMessage` type for parent-to-iframe data delivery. The parent window posts this type; the iframe bridge script converts it to an `AGENT_DATA` CustomEvent. */
  AGENT_DATA_POST: 'ggui-agent-data',
  /** `CustomEvent` name dispatched on `window` when agent data arrives. Components listen for this to receive real-time data from the agent (chat messages, typing indicators, etc.). */
  AGENT_DATA: 'ggui:agent-data',

  // === Component → Agent (outbound via user interaction) ===
  /** `postMessage` type for iframe-to-parent user interaction data. Carries form submissions and click events from generated components back to the host. */
  USER_DATA_POST: 'ggui-user-data',
  /** `CustomEvent` name dispatched on the parent window when user data arrives from the iframe. The host shell listens for this to forward events to the agent. */
  USER_DATA: 'ggui:user-data',

  // === Component → Host (outbound via rendering lifecycle) ===
  /** `postMessage` type sent when a component's content size changes. Used by the host to auto-resize the iframe to fit content. */
  RESIZE: 'ggui-resize',
  /** `postMessage` type sent when a component renders successfully. The host uses this to hide loading indicators and show the component. */
  RENDER_SUCCESS: 'ggui-render-success',
  /** `postMessage` type sent when a component fails to render. The host uses this to show an error state instead of a blank iframe. */
  RENDER_ERROR: 'ggui-render-error',
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

/**
 * Srcdoc JS snippet: universal interaction bridge inside iframe.
 *
 * Three layers of automatic event capture (no props.onSubmit needed):
 *   1. Form submit intercept — captures <form> submissions with all field data
 *   2. Interactive element clicks — buttons, [role="button"], links, [data-action]
 *   3. Cursor-pointer fallback (approach C) — any styled-clickable div/span/card
 *
 * All layers skip if props.onSubmit already handled the event (__ggui_submitHandled).
 * Click handler uses bubble phase so component handlers run first.
 */
export const SRCDOC_USER_DATA_BRIDGE = `
  // Dedup: props.onSubmit sets __ggui_submitHandled = true synchronously.
  // Both layers check this. We use a microtask to reset it so it stays
  // true for ALL handlers in the same event cycle (click + submit).
  function __ggui_wasHandled() {
    if (!window.__ggui_submitHandled) return false;
    // Reset via microtask — stays true for all sync handlers in this tick
    Promise.resolve().then(function() { window.__ggui_submitHandled = false; });
    return true;
  }

  // Layer 1: Form submit intercept (bubble phase — lets component onSubmit run first)
  // Handles: <form> submit via enter key or submit-button click.
  // Uses bubble phase so component's onSubmit (which may call props.onSubmit) fires first.
  document.addEventListener("submit", function(e) {
    e.preventDefault();
    if (__ggui_wasHandled()) return;
    var form = e.target;
    var data = {};
    try { data = Object.fromEntries(new FormData(form)); } catch(_) {}
    parent.postMessage({ type: "ggui-user-data", data: data }, "*");
  });

  // Layers 2+3: Universal click handler (bubble phase — runs after component handlers)
  // Handles: buttons, [role="button"], links, [data-action], cursor:pointer elements.
  // Does NOT handle submit-type elements inside forms (Layer 1 handles those).
  document.addEventListener("click", function(e) {
    if (__ggui_wasHandled()) return;
    if (!e.target || !e.target.closest) return;

    // Layer 2: Find the closest standard interactive element
    var el = e.target.closest("button")
      || e.target.closest("[role='button']")
      || e.target.closest("a[href], a[data-action]")
      || e.target.closest("[data-action]")
      || e.target.closest("[data-ggui-action]");

    // Layer 3 (approach C): Fallback — walk up DOM looking for cursor:pointer
    if (!el) {
      var target = e.target;
      var depth = 0;
      while (target && target !== document.documentElement && depth < 6) {
        if (target.nodeType === 1) {
          try {
            if (window.getComputedStyle(target).cursor === "pointer") {
              el = target;
              break;
            }
          } catch(_) {}
        }
        target = target.parentElement;
        depth++;
      }
    }
    if (!el) return;

    // Skip submit-type elements inside forms — Layer 1 handles those.
    // (click fires before submit, so we must yield to avoid double-fire)
    // <button> defaults to type="submit", so el.type === "submit" catches both
    // <button> and <button type="submit">. Only <button type="button"> is excluded.
    if (el.closest("form") && el.type === "submit") return;

    // Skip form control elements — these are data entry, not actions.
    // Checkboxes, radios, inputs, selects get captured via form submit (Layer 1).
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "LABEL") return;

    // For standalone interactive elements, post click event with label + data attributes
    var data = { action: "click" };
    var label = el.getAttribute("aria-label")
      || el.getAttribute("data-label")
      || el.innerText
      || el.textContent;
    if (label) data.label = label.trim().substring(0, 200);

    // Spread data-* attributes into payload (data-action, data-value, etc.)
    if (el.dataset) {
      for (var key in el.dataset) {
        if (el.dataset.hasOwnProperty(key)) data[key] = el.dataset[key];
      }
    }

    parent.postMessage({ type: "ggui-user-data", data: data }, "*");
  });`;
