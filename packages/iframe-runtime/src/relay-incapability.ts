/**
 * Relay-incapability failure vocabulary.
 *
 * Two modules need to agree on ONE fact: whether a failed
 * `tools/call` failed because this host structurally cannot relay
 * calls to the MCP server, or because something transient went wrong
 * on an otherwise-working relay.
 *
 *   - `runtime.ts` is the THROWER. It owns the relay-incapability
 *     latch (set only after a real user gesture failed relay-shaped
 *     on a host that never advertised `serverTools`) and throws
 *     {@link RelayIncapableError} from `channelToolsCall` before
 *     spending a transport round-trip.
 *   - `channel-transport.ts` is the CLASSIFIER. Its poll tick reads
 *     the thrown value to decide between "back off to a probe
 *     cadence" and "stay quiet, next tick may succeed".
 *
 * The vocabulary lives in its own module rather than in either party
 * because `runtime.ts` already imports `channel-transport.ts` — a
 * reverse import would close a cycle. Naming it for the CONCEPT
 * (relay incapability) rather than for either party keeps the
 * dependency direction obvious.
 *
 * Classification is by type, never by message string: a thrown
 * `Error` whose text happens to mention relaying is NOT a structural
 * failure, and re-wording a message must never silently re-classify
 * a channel.
 */

/**
 * Canonical code carried by {@link RelayIncapableError}. Stable —
 * hosts and tests may compare against it directly.
 */
export const RELAY_INCAPABLE = 'RELAY_INCAPABLE';

/**
 * Thrown when the runtime has CONFIRMED (not merely suspected) that
 * the surrounding host cannot relay `tools/call` to the MCP server,
 * so an attempt would be spent for a guaranteed failure.
 *
 * "Confirmed" is load-bearing. Absence of an advertised `serverTools`
 * capability is NOT confirmation — plenty of hosts under-advertise
 * and relay perfectly well. Only a real gesture that failed
 * relay-shaped sets the latch this error reports, and any later
 * well-formed result envelope clears it.
 *
 * Consumers MUST classify by `instanceof` (or by `code`), never by
 * parsing {@link Error.message}.
 */
export class RelayIncapableError extends Error {
  /** Canonical classification code. */
  readonly code: typeof RELAY_INCAPABLE = RELAY_INCAPABLE;

  constructor() {
    super('tools/call unavailable: host did not advertise serverTools');
    this.name = 'RelayIncapableError';
  }
}

/**
 * Type guard for the structural-failure class. Thrower and classifier
 * are bundled together into one iframe artifact, so `instanceof` is
 * exact here — there is no module-realm boundary between them to
 * defend against.
 */
export function isRelayIncapableError(
  err: unknown,
): err is RelayIncapableError {
  return err instanceof RelayIncapableError;
}
