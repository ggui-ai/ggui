/**
 * Typed errors raised by the self-hosted chat adapter.
 *
 * Kept deliberately small. The server's error envelopes use stable
 * `code` fields (`bad_request` / `not_found` / `conflict` /
 * `unauthenticated` / `internal`). We collapse them to one class that
 * carries the server-supplied code + HTTP status so call sites can
 * branch with a single `instanceof` check.
 */

export interface ThreadTransportErrorInit {
  readonly message: string;
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
}

/**
 * Thrown when the server returned a non-2xx status to a thread
 * operation. `status` is the HTTP status; `code` is the server's
 * structured code (`not_found`, `bad_request`, `conflict`,
 * `unauthenticated`, `internal`, or `network` for pre-response
 * failures).
 */
export class ThreadTransportError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(init: ThreadTransportErrorInit) {
    super(init.message);
    this.name = 'ThreadTransportError';
    this.status = init.status;
    this.code = init.code ?? 'unknown';
    this.details = init.details ?? null;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isBadRequest(): boolean {
    return this.status === 400;
  }
}
