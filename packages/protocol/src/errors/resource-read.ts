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
 * A caller reading a locator it is not allowed to see and a caller
 * reading a locator that never existed MUST receive byte-identical
 * errors. Anything that varies between the two — a message naming a
 * session, a `detail` mentioning a refusal — turns the read into an
 * oracle for the existence of other callers' renders. Rather than
 * leaving that to the discipline of every call site, this function
 * substitutes a constant message and drops `detail` whenever the code
 * is `NOT_FOUND`. Diagnostics for the refused case belong in the
 * server's own logs, which the caller cannot read.
 *
 * # What this function CANNOT enforce — a server obligation
 *
 * Substituting the message closes only the message half of the problem.
 * The code half stays with the caller: a server that runs its
 * authorization check late can hand this function a `NOT_MOUNTABLE` or
 * `BLUEPRINT_UNRESOLVABLE` for a locator the caller was never entitled
 * to read, and the resulting `-32006` reveals that the locator exists —
 * the same oracle, reached by a different route, with a mapper behaving
 * perfectly.
 *
 * So the ordering is normative, scoped to the branches that can leak:
 * a server using this projection MUST route a refusal through
 * `NOT_FOUND`, and MUST NOT run a branch whose outcome VARIES WITH THE
 * LOCATOR before the access check — reaching one of those is itself the
 * disclosure. Resolution work is exactly such a branch, so it happens
 * only after the check has passed.
 *
 * A deployment-global answer is not such a branch. `NOT_SUPPORTED`
 * describes the server and is identical for every locator on a server
 * that emits it, so answering it before any per-locator work — the
 * access check included — reveals nothing and is permitted.
 */
import {
  MCP_ERROR_CODES,
  type ResourceReadError,
  type ResourceReadErrorCode,
} from '../types/mcp.js';

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
  /**
   * Narrowed to the two numbers this projection can emit, so a consumer
   * switching on it gets exhaustiveness rather than an open `number`.
   */
  readonly code:
    | typeof MCP_ERROR_CODES.SESSION_NOT_FOUND
    | typeof MCP_ERROR_CODES.MOUNT_UNAVAILABLE;
  readonly message: string;
  readonly data: {
    readonly code: ResourceReadErrorCode;
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
