/**
 * Console-facing validator-trace sink + REST/SSE endpoints powering
 * `/devtools/validator` in the @ggui-ai/console SPA.
 *
 * This is the OSS-default sink the `ggui serve` process registers via
 * {@link setValidatorTraceSink}. A hosted closed runtime may swap in a
 * durable sink (e.g. Redis-backed) — the harness only knows about the
 * {@link ValidatorTraceSink} contract.
 *
 * **Two surfaces, both admin-gated:**
 *   - `GET /ggui/console/validator/recent?limit=<n>` — JSON snapshot
 *     of the ring buffer's most recent N events, oldest-first within
 *     the page. Used for initial page load.
 *   - `GET /ggui/console/validator/stream` — SSE stream of new events
 *     as they fire. Heartbeat every 15s to keep proxies awake.
 *
 * **Memory bound.** Default capacity = 200 events. Each event carries
 * the source-under-check (capped at ~16KB by truncateSourceForTrace)
 * plus the full issues array — at ~20-30KB/event that's ~4-6MB peak.
 * Operator can override via `createGguiServer({ validatorTrace: {
 * capacity }})` if running on a small box.
 */
import type { Request, Response, Express } from 'express';
import type {
  ValidatorTraceEvent,
  ValidatorTraceSink,
} from '@ggui-ai/ui-gen/harness/validator-trace-sink';
import { applyDevtoolSecurityHeaders } from './console-headers.js';

/** SSE listener — receives one event per runCheck invocation. */
type SseListener = (event: ValidatorTraceEvent) => void;

/**
 * In-memory ring buffer + listener fanout. Implements
 * {@link ValidatorTraceSink} so it can be passed to
 * {@link setValidatorTraceSink}.
 *
 * **Why a class, not a closure.** Tests + operators read state
 * (`recent()`, listener count) — instance methods on a class beat a
 * pile of getter functions captured in scope. The shape is also the
 * extension point if a hosted closed runtime wants to subclass and
 * pipe events to Redis / DDB / S3 in addition to the ring buffer.
 */
export class BoundedValidatorTraceSink implements ValidatorTraceSink {
  private readonly capacity: number;
  private readonly buffer: ValidatorTraceEvent[] = [];
  private readonly listeners = new Set<SseListener>();

  constructor(opts?: { readonly capacity?: number }) {
    const cap = opts?.capacity ?? 200;
    if (!Number.isFinite(cap) || cap <= 0) {
      throw new Error(
        `BoundedValidatorTraceSink: capacity must be a positive integer, got ${cap}`,
      );
    }
    this.capacity = Math.floor(cap);
  }

  emit(event: ValidatorTraceEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One bad listener must not block fan-out to others.
      }
    }
  }

  /**
   * Snapshot of the most-recent `limit` events, oldest-first within
   * the returned slice (so the operator UI can append in chronological
   * order without re-sorting).
   */
  recent(limit: number): readonly ValidatorTraceEvent[] {
    const n = Math.max(0, Math.min(limit, this.buffer.length));
    return this.buffer.slice(-n);
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(listener: SseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Listener count — for tests + the eventual `/devtools/info` view. */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** Buffer size — for tests + future bound enforcement assertions. */
  size(): number {
    return this.buffer.length;
  }
}

/**
 * Mount the `/ggui/console/validator/recent` + `/.../stream` routes on
 * `app`. Caller is responsible for installing the admin gate
 * middleware on these paths beforehand — this function does not
 * re-implement auth.
 */
export function mountConsoleValidatorRoutes(
  app: Express,
  sink: BoundedValidatorTraceSink,
): void {
  // GET /ggui/console/validator/recent?limit=<n> — JSON snapshot.
  app.get(
    '/ggui/console/validator/recent',
    (req: Request, res: Response) => {
      applyDevtoolSecurityHeaders(res);
      const limitRaw = req.query['limit'];
      let limit = 100;
      if (typeof limitRaw === 'string') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(500, parsed);
        }
      }
      res.json({ events: sink.recent(limit) });
    },
  );

  // GET /ggui/console/validator/stream — SSE live stream.
  // Heartbeat comment every 15s so reverse proxies don't kill the
  // connection on idle. Client cleanup unregisters the listener.
  app.get(
    '/ggui/console/validator/stream',
    (req: Request, res: Response) => {
      applyDevtoolSecurityHeaders(res);
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('connection', 'keep-alive');
      // Flush headers immediately so the EventSource starts receiving.
      res.flushHeaders?.();

      const heartbeat = setInterval(() => {
        // SSE comment frame — clients ignore but proxies see traffic.
        res.write(': ping\n\n');
      }, 15000);

      const off = sink.subscribe((event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      req.on('close', () => {
        clearInterval(heartbeat);
        off();
      });
    },
  );
}
