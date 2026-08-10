/**
 * Named events for the content-addressable code-delivery channel.
 *
 * `codeUrl` is the CACHE-ADDRESSABLE static delivery surface of a
 * COMPILED-COMPONENT envelope — since #471 it is no longer the only
 * static one: `deriveRenderMeta` also stamps the size-capped inline
 * `codeB64` twin, independent of this channel's store. A failed
 * `codeUrl` mint therefore usually IS absorbed by the inline channel;
 * what it still costs is deployment-shaped:
 *
 *   - Every under-cap compiled render keeps mounting via `codeB64`
 *     (and, when minted, the live trio). The loss is the browser-
 *     cacheable content-addressable URL — repeat renders of the same
 *     bytes re-ship them inline instead of hitting HTTP cache.
 *   - An OVER-CAP render (no `codeB64`) falls back to exactly the
 *     pre-#471 posture: live trio mounts it; a host that resolves
 *     `resourceUri` re-mints `codeUrl` at READ time; a deployment
 *     with neither loses the mount for that one envelope.
 *
 * None of this is distinguishable from the wire — the render reports
 * success either way — which is why the failure is emitted under a
 * name instead of swallowed. The event carries whether a live channel
 * is wired; combined with the render's size class it separates
 * "slower / uncacheable delivery" from "this envelope cannot mount".
 */

/**
 * Every event this module can emit. Closed union — a new emitter picks
 * from these or extends the type, which is what makes a rename a
 * compile error rather than an alert filter that quietly stops
 * matching.
 */
export type CodeDeliveryEvent =
  | 'render_code_write_failed'
  | 'render_code_b64_over_cap';

/**
 * The event names as values, so every emitter — in this package or a
 * storage backend elsewhere — spells them from one place.
 */
export const CODE_DELIVERY_EVENTS = {
  /**
   * The `codeUrl` mint failed for a render envelope. That envelope
   * loses the cache-addressable static channel; see the module
   * docstring for what survives.
   */
  renderCodeWriteFailed: 'render_code_write_failed',
  /**
   * A compiled render's source exceeded the inline `codeB64` cap, so
   * the slice was emitted WITHOUT the fetch-free channel. On hosts
   * whose iframe CSP blocks fetches AND WebSockets, that render
   * cannot paint — the omission must be visible, not silent.
   */
  renderCodeB64OverCap: 'render_code_b64_over_cap',
} as const satisfies Record<string, CodeDeliveryEvent>;

/**
 * What an emitter knows at the point the mint failed.
 */
export interface RenderCodeWriteFailure {
  /** Render whose envelope lost its static channel. */
  readonly sessionId: string;
  /** Owning app, so the event joins the rest of a deployment's logs. */
  readonly appId: string;
  /**
   * Whether this deployment mints live-channel credentials.
   *
   * `true` ⇒ the render still mounts over the WS subscribe; the loss
   * is the instant first paint. `false` ⇒ the envelope mounts only
   * through the inline `codeB64` channel (present for every under-cap
   * compiled render, independent of this store); an OVER-CAP render
   * with `false` here truly has no mount mode, and only a host that
   * resolves `resourceUri` will still produce a card.
   */
  readonly liveChannelWired: boolean;
  /** Whatever the store threw. Unshaped by construction. */
  readonly cause: unknown;
}

/**
 * Emit {@link CODE_DELIVERY_EVENTS.renderCodeWriteFailed}.
 *
 * Never throws: a render that already produced valid code and already
 * committed must not fail because its delivery-channel telemetry did.
 */
export function reportRenderCodeWriteFailed(
  failure: RenderCodeWriteFailure,
): void {
  // eslint-disable-next-line no-console -- structured single-line event for log-pipeline pickup
  console.warn(
    JSON.stringify({
      msg: CODE_DELIVERY_EVENTS.renderCodeWriteFailed,
      sessionId: failure.sessionId,
      appId: failure.appId,
      liveChannelWired: failure.liveChannelWired,
      error:
        failure.cause instanceof Error
          ? failure.cause.message
          : String(failure.cause),
      errorName:
        failure.cause instanceof Error ? failure.cause.name : undefined,
    }),
  );
}

/**
 * Emit {@link CODE_DELIVERY_EVENTS.renderCodeB64OverCap}.
 *
 * Never throws — same posture as the write-failure emitter above.
 */
export function reportRenderCodeB64OverCap(over: {
  readonly sessionId: string;
  readonly appId: string;
  /** UTF-8 byte length of the compiled source that exceeded the cap. */
  readonly sourceBytes: number;
}): void {
  // eslint-disable-next-line no-console -- structured single-line event for log-pipeline pickup
  console.warn(
    JSON.stringify({
      msg: CODE_DELIVERY_EVENTS.renderCodeB64OverCap,
      sessionId: over.sessionId,
      appId: over.appId,
      sourceBytes: over.sourceBytes,
    }),
  );
}
