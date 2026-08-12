/**
 * Epoch-pinned resource URIs (#483).
 *
 * A session's history is a linear chain of epoch-numbered render
 * records: `ggui_render` mints epoch 0; every `ggui_update` advances
 * the head by one (`ggui_amend` never does). The epoch rides the
 * resource URI:
 *
 *   - **Bare URI** (`ui://ggui/render/<sessionId>[/<contractKey>]`) —
 *     the LIVE HEAD. Reads track the session's current state.
 *   - **Pinned URI** (`…#N`) — the immutable epoch-N record. Reads
 *     MUST serve identical content forever (conformance-pinned).
 *
 * This module is the ONE encoding seam: every producer (result-meta
 * stamping, resource templates) and consumer (iframe-runtime latch,
 * pinned reads) routes through these two functions, so the encoding
 * (URI fragment today) can flip to a path segment after the
 * host-transport probe without touching call sites. Do not hand-roll
 * `#${n}` anywhere else.
 */
export const EPOCH_URI_SEPARATOR = '#';

/**
 * Compose the pinned URI for an epoch. Throws on non-integer or
 * negative epochs — a producer stamping a bogus epoch is a bug that
 * must be loud, not a tolerable wire variant.
 */
export function composeEpochUri(baseUri: string, epoch: number): string {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error(`epoch must be a non-negative integer, got ${epoch}`);
  }
  return `${baseUri}${EPOCH_URI_SEPARATOR}${epoch}`;
}

export interface ParsedEpochUri {
  /** The URI with any epoch pin removed — the live-head address. */
  readonly baseUri: string;
  /** Present iff the URI carried a well-formed epoch pin. */
  readonly epoch?: number;
}

/**
 * Tolerant read — never throws. A malformed suffix (non-canonical
 * number, leading zeros, empty) is NOT an epoch: the whole input
 * passes through as `baseUri` so an exotic-but-legal URI is never
 * mangled by mis-parsing. Canonical epochs only: `0` or a digit
 * string with no leading zero.
 */
export function parseEpochUri(uri: string): ParsedEpochUri {
  const idx = uri.lastIndexOf(EPOCH_URI_SEPARATOR);
  if (idx < 0) return { baseUri: uri };
  const suffix = uri.slice(idx + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(suffix)) return { baseUri: uri };
  return { baseUri: uri.slice(0, idx), epoch: Number(suffix) };
}
