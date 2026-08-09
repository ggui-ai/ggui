/**
 * Named events for the content-addressable code-delivery channel.
 *
 * `codeUrl` is the only STATIC delivery surface a render envelope has.
 * Nothing sits behind it: a bootstrap mounts on `codeUrl`, on a
 * system-card `kind`, or on the live trio (`wsUrl` + `wsToken`) — and
 * an envelope carrying none of the three reads to a host as "not a
 * mountable ggui render". So a failed `codeUrl` mint is not absorbed
 * by a second static channel; what happens next is deployment-shaped:
 *
 *   - A deployment that mints live-channel credentials still mounts.
 *     The slice keeps `wsUrl` + `wsToken`, the iframe subscribes, and
 *     the WS delivers the render body. The cost is the
 *     zero-round-trip first paint, not the render.
 *   - A host that resolves the render's `resourceUri` re-mints
 *     `codeUrl` against the same store at READ time, so a transient
 *     fault costs it nothing and a persistent one surfaces there as a
 *     read error rather than a blank card.
 *   - A deployment with neither loses the mount for that one
 *     envelope.
 *
 * None of the three is distinguishable from the wire — the render
 * reports success either way — which is why the failure is emitted
 * under a name instead of swallowed. The event carries whether a live
 * channel is wired, because that is the difference between "slower
 * first paint" and "this envelope cannot mount".
 */

/**
 * Every event this module can emit. Closed union — a new emitter picks
 * from these or extends the type, which is what makes a rename a
 * compile error rather than an alert filter that quietly stops
 * matching.
 */
export type CodeDeliveryEvent = 'render_code_write_failed';

/**
 * The event names as values, so every emitter — in this package or a
 * storage backend elsewhere — spells them from one place.
 */
export const CODE_DELIVERY_EVENTS = {
  /**
   * The `codeUrl` mint failed for a render envelope. That envelope
   * carries no static delivery channel; see the module docstring for
   * what survives.
   */
  renderCodeWriteFailed: 'render_code_write_failed',
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
   * is the instant first paint. `false` ⇒ this envelope has no mount
   * mode at all, and only a host that resolves `resourceUri` will
   * still produce a card.
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
