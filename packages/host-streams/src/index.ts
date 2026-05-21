/**
 * `@ggui-ai/host-streams` — host-side stream mediator for ggui.
 *
 * **Status**: early scaffold. The public interface (type-only
 * exports + factory) is stable, but the runtime implementation is
 * not yet wired — `createHostStreamManager` returns a stub whose
 * methods throw until the runtime port lands.
 *
 * Hosts call:
 *
 *     const streams = createHostStreamManager({...});
 *     const unbind = streams.bindIframe(iframeEl, {sessionId, appId, stackItemId});
 *     // on unmount:
 *     unbind();
 *
 * Behind the scenes the manager:
 *   - Listens for `ui/extensions/ggui/stream-subscribe` postMessages
 *     from each bound iframe.
 *   - Decides WS-subscribe vs `tools/call`-poll per channel based on
 *     `streamWebSocketLocalTools` allowlist + WS availability.
 *   - Fans payloads via `iframe.contentWindow.postMessage` —
 *     browser-enforced per-iframe targeting.
 *
 * @public
 */

export * from './envelopes.js';
export type {
  HostMcpToolCaller,
  HostStreamWsConfig,
  BindIframeOptions,
  UnbindIframe,
  HostStreamObservabilityEvent,
  HostStreamManagerConfig,
  HostStreamManager,
} from './types.js';
export { createHostStreamManager } from './manager.js';
export { DEFAULT_HOST_POLL_INTERVAL_MS } from './manager.js';
