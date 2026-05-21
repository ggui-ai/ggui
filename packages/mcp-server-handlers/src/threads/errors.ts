/**
 * Handler-level error classes for the threads/ family.
 *
 * The two error tiers kept deliberately separate:
 *
 *   - **Request-shape errors** ({@link InvalidThreadRequestError}).
 *     Raised by the handlers themselves when input fails schema
 *     validation — transport returns 400 Bad Request.
 *
 *   - **Store errors** — re-exported from `@ggui-ai/mcp-server-core`
 *     and surfaced verbatim by the handlers. Transport maps them to
 *     HTTP status codes (`ThreadNotFoundError` → 404,
 *     `InvalidThreadActionError` → 400,
 *     `ThreadActionInvalidStateError` → 409).
 *
 * Handlers MUST NOT invent new semantic error classes. Every new
 * failure case either maps back to one of the three store errors or
 * is a request-shape error. Anything else implies the store boundary
 * is leaking concerns it shouldn't own — fix there, not here.
 */
export {
  InvalidThreadActionError,
  ThreadActionInvalidStateError,
  ThreadNotFoundError,
} from '@ggui-ai/mcp-server-core';

/**
 * Raised when a thread handler receives malformed input — unknown
 * fields are fine (the schemas use `.strict()` only where ambiguity
 * would be dangerous; otherwise we pass extras through for forward-
 * compatibility), but missing/wrong-typed required fields fail here.
 *
 * `issues` is a machine-readable snapshot of the zod error's
 * `issues[]`. Transports that want to return structured 400s use it;
 * transports that return a flat `{ error: string }` just read
 * `message`.
 */
export class InvalidThreadRequestError extends Error {
  readonly code = 'INVALID_THREAD_REQUEST';
  readonly issues: readonly unknown[];

  constructor(message: string, issues: readonly unknown[] = []) {
    super(message);
    this.name = 'InvalidThreadRequestError';
    this.issues = issues;
  }
}
