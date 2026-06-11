/**
 * Thread transport — HTTP routes for the persistent-chat surface.
 *
 * Thin binding over `@ggui-ai/mcp-server-handlers/threads`. Every
 * route:
 *
 *   1. Resolves identity via the existing `AuthAdapter` (same path
 *      `/mcp` + pairing use — no second identity plane).
 *   2. Maps the identity to a stable `ownerId` string (see
 *      {@link ThreadOwnerResolver}).
 *   3. Calls the shared handler with `{ ownerId, requestId }`.
 *   4. Maps handler / store errors to stable HTTP status codes.
 *
 * Routes mounted:
 *
 *   POST   /threads                       → createThread
 *   GET    /threads                       → listThreads
 *   GET    /threads/:id                   → getThread
 *   PATCH  /threads/:id                   → applyThreadAction
 *   GET    /threads/:id/messages          → listMessages
 *   POST   /threads/:id/messages          → appendMessage
 *   GET    /threads/:id/stream            → observeMessages (SSE)
 *
 * Error mapping (the ONLY transport-level semantic):
 *
 *   InvalidThreadRequestError           → 400 bad_request
 *   ThreadNotFoundError                 → 404 not_found (wrong-owner + missing
 *                                          collapse to the same code)
 *   InvalidThreadActionError            → 400 bad_request (defense-in-depth;
 *                                          handler-level schema parses first)
 *   ThreadActionInvalidStateError       → 409 conflict
 *   UnauthenticatedError                → 401 unauthenticated
 *   (anything else)                     → 500 internal
 *
 * Error envelopes match the pairing-transport shape so clients see one
 * error-body contract across every non-/mcp route:
 *
 *   { error: { code: 'bad_request' | 'not_found' | 'conflict' | ...,
 *              message: string,
 *              details?: unknown } }
 */
import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type {
  AuthAdapter,
  AuthResult,
  ThreadStore,
} from '@ggui-ai/mcp-server-core';
import {
  appendMessage,
  applyThreadAction,
  createThread,
  getThread,
  InvalidThreadActionError,
  InvalidThreadRequestError,
  listMessages,
  listThreads,
  observeMessages,
  ThreadActionInvalidStateError,
  ThreadNotFoundError,
  type ThreadHandlerContext,
} from '@ggui-ai/mcp-server-handlers/threads';
import type { ThreadStreamEvent } from '@ggui-ai/protocol';
import { isRecord } from '@ggui-ai/protocol';
import { resolveIdentity, UnauthenticatedError } from './auth.js';
import type { Logger } from './logger.js';

/** Default URL prefix the thread routes are mounted at. */
export const DEFAULT_THREADS_PATH = '/threads';

/**
 * Resolve the stable thread-partition key (`ownerId`) from the
 * authenticated identity.
 *
 * The protocol pins the canonical shapes:
 *   - Closed-cloud variants: `cognito_<sub>` / `guest_<uuidv4>` (not
 *     our concern here — the closed binding supplies its own resolver).
 *   - Self-hosted: `paired_<pairingId>` for pairing-minted tokens;
 *     kind-scoped fallback for everything else.
 *
 * The default {@link defaultThreadOwnerFromIdentity} implements that
 * rule. Operators who need a different partition key (e.g. a multi-
 * user OSS fork) pass their own via `threads.ownerFromIdentity`.
 */
export type ThreadOwnerResolver = (result: AuthResult) => string;

export const DEFAULT_BUILDER_OWNER_ID = 'builder';

/**
 * Default identity → ownerId mapping for the OSS server.
 *
 * Preserves the protocol's "self-hosted → typically `paired_<pairingId>`"
 * convention whenever the token was minted by pairing: the bridge in
 * `createGguiServer` passes `metadata: { pairingId }` on `onTokenIssued`,
 * which surfaces here via `AuthResult.metadata.pairingId`. Fallbacks:
 *
 *   - `source: 'cognito'` with a `sub` metadata field → `cognito_<sub>`
 *     (parallel adapters in any closed cloud runtime; not a shape the
 *     OSS server ships today but the mapping is stable so custom
 *     adapters are uniform).
 *   - `kind: 'user'` → `user_<workspaceId ?? userId>` — same partition
 *     rule `defaultAppIdFromIdentity` uses.
 *   - `kind: 'builder'` with no pairing metadata (dev mode / manual
 *     token) → {@link DEFAULT_BUILDER_OWNER_ID}.
 *
 * Keeping every OSS-reachable identity collapsed to ONE owner by
 * default is correct: OSS is a single-operator tier. Operators who
 * split owners across multiple tokens pass a custom resolver.
 */
export function defaultThreadOwnerFromIdentity(result: AuthResult): string {
  const pairingId = result.metadata?.['pairingId'];
  if (typeof pairingId === 'string' && pairingId.length > 0) {
    return `paired_${pairingId}`;
  }
  if (result.source === 'cognito') {
    const sub = result.metadata?.['sub'];
    if (typeof sub === 'string' && sub.length > 0) return `cognito_${sub}`;
  }
  if (result.identity.kind === 'user') {
    return `user_${result.identity.workspaceId ?? result.identity.userId}`;
  }
  // `kind: 'app'` is a per-app machine caller (e.g. an agent-builder
  // API key hitting a hosted multi-tenant deployment). Threads owned
  // by an app should be scoped to that app, NOT pooled into the
  // default builder bucket — the latter would let two apps see each
  // other's threads.
  if (result.identity.kind === 'app') {
    return `app_${result.identity.appId}`;
  }
  return DEFAULT_BUILDER_OWNER_ID;
}

export interface ThreadTransportOptions {
  /** Required. Store implementation the handlers call through to. */
  readonly store: ThreadStore;
  /**
   * Required. Same AuthAdapter the `/mcp` + live-channel + pairing
   * endpoints use. Identity resolution goes through this — thread
   * routes never invent their own auth path.
   */
  readonly auth: AuthAdapter;
  /** Structured logger. Child loggers are derived per-route. */
  readonly logger: Logger;
  /**
   * URL prefix. Defaults to `/threads`. Six routes are registered
   * beneath it:
   *   POST / GET on the prefix itself, GET / PATCH on `/:id`,
   *   GET / POST on `/:id/messages`.
   */
  readonly path?: string;
  /**
   * Identity → ownerId mapping. Defaults to
   * {@link defaultThreadOwnerFromIdentity}. A hosted closed runtime
   * overrides to map Cognito claims to `cognito_<sub>` / `guest_<id>`;
   * OSS forks that partition multiple operators override as needed.
   */
  readonly ownerFromIdentity?: ThreadOwnerResolver;
}

/**
 * Mount the six thread routes onto an existing Express app.
 *
 * Idempotent is NOT a goal — call once per server. `createGguiServer`
 * owns the single call site via `opts.threads`.
 */
export function mountThreadTransport(
  app: Express,
  opts: ThreadTransportOptions,
): void {
  const prefix = opts.path ?? DEFAULT_THREADS_PATH;
  const ownerFromIdentity =
    opts.ownerFromIdentity ?? defaultThreadOwnerFromIdentity;
  const deps = { threads: opts.store };

  // Resolve identity + ownerId in one place. Every route calls this
  // first; on failure it writes the response and returns null so the
  // route handler short-circuits. Returning null via a shared helper
  // means no route accidentally proceeds without identity.
  async function requireOwnerContext(
    req: Request,
    res: Response,
    routeLogger: Logger,
  ): Promise<ThreadHandlerContext | null> {
    const requestId =
      typeof req.headers['x-request-id'] === 'string'
        ? req.headers['x-request-id']
        : randomUUID();
    try {
      const identity = await resolveIdentity(opts.auth, req);
      const ownerId = ownerFromIdentity(identity);
      return { ownerId, requestId };
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        routeLogger.warn('thread_auth_failed', { reason: err.message });
        res.status(401).json({
          error: { code: 'unauthenticated', message: err.message },
        });
        return null;
      }
      routeLogger.error('thread_auth_unexpected_error', {
        error: String(err),
      });
      res.status(500).json({
        error: { code: 'internal', message: 'Internal server error' },
      });
      return null;
    }
  }

  /**
   * Map a thrown handler / store error to the stable HTTP envelope.
   * Central for two reasons: (1) every route has the same mapping
   * rules, so DRY; (2) adding a new error class is a one-liner here
   * instead of six places.
   */
  function handleError(
    err: unknown,
    res: Response,
    routeLogger: Logger,
    routeLabel: string,
  ): void {
    if (err instanceof InvalidThreadRequestError) {
      routeLogger.debug?.('thread_bad_request', {
        route: routeLabel,
        message: err.message,
      });
      res.status(400).json({
        error: {
          code: 'bad_request',
          message: err.message,
          details: { issues: err.issues },
        },
      });
      return;
    }
    if (err instanceof InvalidThreadActionError) {
      // Handler-schema parsing rejects unknown actions first (→
      // InvalidThreadRequestError). This branch covers direct-call
      // paths where the store validates. 400 matches the "malformed
      // action value" semantics.
      routeLogger.debug?.('thread_invalid_action', {
        route: routeLabel,
        message: err.message,
      });
      res.status(400).json({
        error: { code: 'bad_request', message: err.message },
      });
      return;
    }
    if (err instanceof ThreadActionInvalidStateError) {
      routeLogger.debug?.('thread_action_invalid_state', {
        route: routeLabel,
        message: err.message,
      });
      res.status(409).json({
        error: { code: 'conflict', message: err.message },
      });
      return;
    }
    if (err instanceof ThreadNotFoundError) {
      routeLogger.debug?.('thread_not_found', {
        route: routeLabel,
        message: err.message,
      });
      res.status(404).json({
        error: { code: 'not_found', message: err.message },
      });
      return;
    }
    routeLogger.error('thread_route_unexpected_error', {
      route: routeLabel,
      error: String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({
        error: { code: 'internal', message: 'Internal server error' },
      });
    }
  }

  // --- POST /threads ---
  app.post(prefix, async (req, res) => {
    const routeLogger = opts.logger.child({ route: 'POST ' + prefix });
    const ctx = await requireOwnerContext(req, res, routeLogger);
    if (!ctx) return;
    try {
      const thread = await createThread(deps, req.body ?? {}, ctx);
      res.status(201).json(thread);
    } catch (err) {
      handleError(err, res, routeLogger, 'POST ' + prefix);
    }
  });

  // --- GET /threads ---
  //
  // Filter comes from the query string. `limit` arrives as a string
  // from Express; coerce before handing to the handler (the
  // handler's zod schema would otherwise reject `"50"` as not a
  // number). Everything else is already a string or absent.
  app.get(prefix, async (req, res) => {
    const routeLogger = opts.logger.child({ route: 'GET ' + prefix });
    const ctx = await requireOwnerContext(req, res, routeLogger);
    if (!ctx) return;
    try {
      const filter = coerceQueryToFilter(req.query);
      const result = await listThreads(deps, filter, ctx);
      res.json(result);
    } catch (err) {
      handleError(err, res, routeLogger, 'GET ' + prefix);
    }
  });

  // --- GET /threads/:id ---
  app.get(`${prefix}/:id`, async (req, res) => {
    const routeLogger = opts.logger.child({ route: 'GET ' + prefix + '/:id' });
    const ctx = await requireOwnerContext(req, res, routeLogger);
    if (!ctx) return;
    try {
      const thread = await getThread(
        deps,
        { threadId: req.params.id },
        ctx,
      );
      res.json(thread);
    } catch (err) {
      handleError(err, res, routeLogger, 'GET ' + prefix + '/:id');
    }
  });

  // --- PATCH /threads/:id ---
  //
  // Body: `{ action: ThreadStateAction }`. PATCH picked (over POST
  // on `/:id/actions`) because the action is a state transition on
  // the resource, not a new sub-resource — the same framing the
  // thread-adapter interface uses (`updateThreadState`).
  app.patch(`${prefix}/:id`, async (req, res) => {
    const routeLogger = opts.logger.child({
      route: 'PATCH ' + prefix + '/:id',
    });
    const ctx = await requireOwnerContext(req, res, routeLogger);
    if (!ctx) return;
    try {
      const thread = await applyThreadAction(
        deps,
        { threadId: req.params.id, body: req.body ?? {} },
        ctx,
      );
      res.json(thread);
    } catch (err) {
      handleError(err, res, routeLogger, 'PATCH ' + prefix + '/:id');
    }
  });

  // --- GET /threads/:id/messages ---
  app.get(`${prefix}/:id/messages`, async (req, res) => {
    const routeLogger = opts.logger.child({
      route: 'GET ' + prefix + '/:id/messages',
    });
    const ctx = await requireOwnerContext(req, res, routeLogger);
    if (!ctx) return;
    try {
      const result = await listMessages(
        deps,
        {
          threadId: req.params.id,
          options: coerceQueryToMessageOptions(req.query),
        },
        ctx,
      );
      res.json(result);
    } catch (err) {
      handleError(
        err,
        res,
        routeLogger,
        'GET ' + prefix + '/:id/messages',
      );
    }
  });

  // --- POST /threads/:id/messages ---
  //
  // The body carries every field except `threadId` (which comes from
  // the URL). The handler requires `threadId` on its input envelope,
  // so we fold it in here — caller-supplied `threadId` in the body
  // (if any) is intentionally overwritten by the URL segment, which
  // is the canonical truth for a RESTful path-scoped write.
  app.post(`${prefix}/:id/messages`, async (req, res) => {
    const routeLogger = opts.logger.child({
      route: 'POST ' + prefix + '/:id/messages',
    });
    const ctx = await requireOwnerContext(req, res, routeLogger);
    if (!ctx) return;
    try {
      const body: Record<string, unknown> = isRecord(req.body) ? req.body : {};
      const input = { ...body, threadId: req.params.id };
      const message = await appendMessage(deps, input, ctx);
      res.status(201).json(message);
    } catch (err) {
      handleError(
        err,
        res,
        routeLogger,
        'POST ' + prefix + '/:id/messages',
      );
    }
  });

  // --- GET /threads/:id/stream (SSE) ---
  //
  // Serializes frames from the Step 3 `observeMessages` handler's
  // AsyncIterable. Pre-header error handling is the interesting bit:
  //
  //   1. Resolve auth + ownerId (JSON-error channel).
  //   2. Parse query options (JSON-error channel on shape failures).
  //   3. Construct the iterator and call `.next()`.
  //   4. Race that first `.next()` against `setImmediate`:
  //        - If it rejects synchronously → ThreadNotFoundError /
  //          InvalidThreadRequestError → write JSON error response
  //          with the right status code, NEVER write SSE headers.
  //        - If it resolves synchronously (backlog available or
  //          tail:false+empty backlog) → headers committed + that
  //          first result is sent as the initial SSE frame.
  //        - If it's still pending after one macrotask → ownership
  //          has passed (the store's wrong-owner check is
  //          synchronous), so headers can safely commit. The
  //          already-queued `firstNext` becomes the first frame
  //          whenever the first append lands.
  //
  // This keeps wrong-owner and missing-thread both 404'd BEFORE SSE
  // headers are flushed — clients see the same error envelope they
  // see on the JSON routes. The alternative (flush 200 then write a
  // terminal error event) would silently convert a 404 into a 200,
  // breaking the partition-indistinguishability rule.
  app.get(`${prefix}/:id/stream`, async (req, res) => {
    const routeLogger = opts.logger.child({
      route: 'GET ' + prefix + '/:id/stream',
    });
    const ctx = await requireOwnerContext(req, res, routeLogger);
    if (!ctx) return;

    // Parse fromSeq from query. Tail is always true for SSE — the
    // whole point of the endpoint is a live subscription. If a
    // future caller wants a one-shot snapshot they'd use
    // `GET /messages`, not stream.
    let iterable: AsyncIterable<import('@ggui-ai/protocol').ThreadMessage>;
    try {
      iterable = observeMessages(
        deps,
        {
          threadId: req.params.id,
          options: coerceQueryToObserveOptions(req.query),
        },
        ctx,
      );
    } catch (err) {
      handleError(err, res, routeLogger, 'GET ' + prefix + '/:id/stream');
      return;
    }

    const iter = iterable[Symbol.asyncIterator]();

    // Client-disconnect cleanup — set up BEFORE the race so that a
    // disconnect during the ownership-probe window still disposes
    // the iterator.
    let clientClosed = false;
    res.on('close', () => {
      clientClosed = true;
      if (iter.return) {
        iter.return(undefined).catch(() => undefined);
      }
    });

    // --- Ownership probe ---
    // The store's observeMessages rejects the first `.next()`
    // synchronously for wrong-owner / missing. On an empty thread
    // with tail:true, the first `.next()` stays pending indefinitely.
    // We distinguish by racing one macrotask.
    const firstNext = iter.next();
    type ProbeResult =
      | { kind: 'settled'; result: IteratorResult<import('@ggui-ai/protocol').ThreadMessage> }
      | { kind: 'rejected'; error: unknown }
      | { kind: 'pending' };
    const probe: ProbeResult = await Promise.race([
      firstNext.then(
        (r): ProbeResult => ({ kind: 'settled', result: r }),
        (err): ProbeResult => ({ kind: 'rejected', error: err }),
      ),
      new Promise<ProbeResult>((resolve) =>
        setImmediate(() => resolve({ kind: 'pending' })),
      ),
    ]);

    if (probe.kind === 'rejected') {
      handleError(probe.error, res, routeLogger, 'GET ' + prefix + '/:id/stream');
      return;
    }

    if (clientClosed) {
      // Client gave up before we even committed headers. Nothing to
      // send; iterator has already been disposed by the close hook.
      return;
    }

    // Commit SSE headers.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Consume the first result + continue the loop. The try/catch
    // here covers post-header failures (e.g. a deferred store error
    // surfacing through the pending firstNext). On that path we can't
    // return 4xx — just log and close cleanly.
    try {
      if (probe.kind === 'settled') {
        if (!probe.result.done) {
          writeEventFrame(res, probe.result.value);
        } else {
          res.end();
          return;
        }
      } else {
        // Probe ended as pending. firstNext still resolves in the
        // normal path; await it like any subsequent iteration.
        const first = await firstNext;
        if (first.done) {
          res.end();
          return;
        }
        writeEventFrame(res, first.value);
      }

      while (!clientClosed) {
        const result = await iter.next();
        if (result.done) break;
        writeEventFrame(res, result.value);
      }
      res.end();
    } catch (err) {
      // Deferred error after headers are committed. Best-effort
      // terminal-event shape (clients can still dedupe on seq), then
      // close. NEVER reset the status code — headers are out.
      routeLogger.warn('thread_stream_deferred_error', {
        error: String(err),
      });
      if (!res.writableEnded) {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
        } catch {
          // Socket may be gone — swallow.
        }
        res.end();
      }
    }
  });
}

/**
 * Emit one ThreadMessage as an SSE frame. Frame shape:
 *
 *   id: <seq>
 *   event: thread-message
 *   data: <JSON-encoded ThreadStreamEvent>
 *   \n
 *
 * The `id` field carries the `seq` so clients automatically get the
 * Last-Event-ID reconnect hint (the browser's EventSource sends the
 * last-seen id back on `?fromSeq=<last+1>`-aware reconnects; CLI
 * consumers honor it manually). Event type is the shipped
 * `ThreadStreamEvent` discriminant — v1 is `'thread-message'`;
 * future additions stay forward-compatible because clients dedupe
 * on seq + ignore unknown event types.
 */
function writeEventFrame(
  res: Response,
  message: import('@ggui-ai/protocol').ThreadMessage,
): void {
  const event: ThreadStreamEvent = { type: 'thread-message', message };
  res.write(
    `id: ${message.seq}\nevent: thread-message\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

/**
 * Coerce Express's query object (`string | string[] | ParsedQs | ...`)
 * into the shape {@link listThreadsFilterSchema} expects. We only
 * coerce fields the filter knows about; extras pass through untouched
 * and the handler's strict schema rejects them (so a typo like
 * `?stats=archived` returns 400 instead of silently ignoring the
 * filter — catches client bugs fast).
 */
function coerceQueryToFilter(
  query: Request['query'],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof query['status'] === 'string') out['status'] = query['status'];
  if (typeof query['appId'] === 'string') out['appId'] = query['appId'];
  if (typeof query['cursor'] === 'string') out['cursor'] = query['cursor'];
  if (typeof query['limit'] === 'string') {
    const n = Number(query['limit']);
    out['limit'] = Number.isFinite(n) ? n : query['limit'];
  }
  return out;
}

function coerceQueryToMessageOptions(
  query: Request['query'],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof query['cursor'] === 'string') out['cursor'] = query['cursor'];
  if (typeof query['fromSeq'] === 'string') {
    const n = Number(query['fromSeq']);
    out['fromSeq'] = Number.isFinite(n) ? n : query['fromSeq'];
  }
  if (typeof query['limit'] === 'string') {
    const n = Number(query['limit']);
    out['limit'] = Number.isFinite(n) ? n : query['limit'];
  }
  return out;
}

/**
 * Coerce SSE stream query params.
 *
 * `?fromSeq=<n>` is the only knob the stream endpoint honors — tail
 * is always on (the endpoint IS a subscription). Limit is not
 * meaningful for a stream and cursor is a paginated-read concept;
 * both are omitted here and the handler's strict schema rejects
 * them if passed (so a misdirected client query gets 400 instead of
 * silently ignoring the knob).
 */
function coerceQueryToObserveOptions(
  query: Request['query'],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof query['fromSeq'] === 'string') {
    const n = Number(query['fromSeq']);
    out['fromSeq'] = Number.isFinite(n) ? n : query['fromSeq'];
  }
  return out;
}
