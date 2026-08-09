/**
 * Projection from a typed `resources/read` failure onto a JSON-RPC
 * error (SPEC §7.9 Plane 1).
 *
 * A read of a render locator (`ui://ggui/render/{sessionId}/{blueprintKey}`)
 * returns either a live mount or an error — never a successful result
 * carrying a shell that will never come alive. Routing every failure
 * branch through this one function is what makes that host-checkable:
 * "any successful `contents` result IS a live mount" holds because the
 * only other exit is a JSON-RPC error.
 *
 * # Numeric codes
 *
 * `NOT_FOUND` maps to `-32002`. That is the number MCP itself uses for
 * a resource that does not exist, and the number this protocol already
 * assigns to a missing session — for a locator keyed by `sessionId`
 * those are one condition, not two.
 *
 * The other three map to `MOUNT_UNAVAILABLE` (`-32006`), a canonical
 * code claimed from the range the protocol reserves for new ones. They
 * are deliberately NOT `INTERNAL_ERROR`: a purged component, a server
 * that keeps no durable record, and a render with no delivery channel
 * are all deterministic outcomes of a correctly functioning server.
 * `-32603` would report them as a malfunction and invite hosts to retry
 * a read that cannot ever succeed. The fine-grained classification
 * rides on `error.data.code`, so a host that only understands the
 * number still routes correctly, and one that reads `data.code` can
 * distinguish "come back never" from "come back with a fresh render".
 *
 * # Why `NOT_FOUND` loses its message
 *
 * A caller reading a locator that belongs to someone else and a caller
 * reading a locator that never existed MUST receive byte-identical
 * errors. Anything that varies between the two — a message naming a
 * session, a `detail` mentioning a denial — turns the read into an
 * oracle for the existence of other callers' renders. Rather than
 * leaving that to the discipline of every call site, this function
 * substitutes a constant message and drops `detail` whenever the code
 * is `NOT_FOUND`. Diagnostics for the denied case belong in the
 * server's own logs, which the caller cannot read.
 */
import { MCP_ERROR_CODES, type ResourceReadError } from '../types/mcp.js';

/**
 * The single message every `NOT_FOUND` read returns, whatever the
 * underlying reason. Names no session, app, or caller.
 */
export const RESOURCE_NOT_FOUND_MESSAGE = 'Resource not found.';

/**
 * JSON-RPC error body for a failed `resources/read`. `data.code` is the
 * closed classification; `data.detail` is optional operator context and
 * is absent whenever `data.code` is `NOT_FOUND`.
 */
export interface ResourceReadJsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data: {
    readonly code: ResourceReadError['code'];
    readonly detail?: string;
  };
}

/**
 * Switch rather than an `if` with a fallthrough on purpose: every member
 * of the enum is named, so adding a fifth code fails to compile here
 * until someone decides which number it carries. A default branch would
 * have swallowed it into `MOUNT_UNAVAILABLE` silently.
 */
export function resourceReadErrorToJsonRpc(
  err: ResourceReadError,
): ResourceReadJsonRpcError {
  switch (err.code) {
    case 'NOT_FOUND':
      // Constant body — see "Why NOT_FOUND loses its message" above.
      return {
        code: MCP_ERROR_CODES.SESSION_NOT_FOUND,
        message: RESOURCE_NOT_FOUND_MESSAGE,
        data: { code: 'NOT_FOUND' },
      };
    case 'BLUEPRINT_UNRESOLVABLE':
    case 'NOT_SUPPORTED':
    case 'NOT_MOUNTABLE':
      return {
        code: MCP_ERROR_CODES.MOUNT_UNAVAILABLE,
        message: err.message,
        data:
          err.detail === undefined
            ? { code: err.code }
            : { code: err.code, detail: err.detail },
      };
  }
}
