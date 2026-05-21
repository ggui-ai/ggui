/**
 * Server-Sent Events endpoint for `ggui dev`.
 *
 * One-way server → client stream of `UiRegistryEvent`. SSE is the
 * minimum viable transport for the dev HMR loop: browser-native
 * on EventSource / fetch-streaming, no handshake complexity, no
 * duplex message framing, survives reconnect via the built-in
 * last-event-id mechanism (not used in this first slice but the
 * format is compatible if we need it later).
 *
 * Auth: `/events` is bearer-gated like the rest of the endpoints
 * (not public like `/health`). The existing security-policy layer
 * in `./http.ts` runs before this handler and applies the same
 * origin allowlist + Authorization token check.
 *
 * Wire format (per event):
 *
 *     event: ui
 *     data: {"type":"changed","id":"weather-card","contentHash":""}
 *
 * A periodic `:keep-alive` comment keeps the connection open
 * through idle proxies without affecting the data stream.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UiRegistryEvent } from '@ggui-ai/ui-registry';
import type { LocalUiRegistry } from '../local-registry/local-registry.js';

/**
 * Subscribe options the http router hands down so the tests can
 * override the keep-alive cadence and the heartbeat doesn't keep
 * processes alive past test shutdown.
 */
export interface SseOptions {
  /** Milliseconds between `:keep-alive` comments. `0` disables. */
  keepAliveMs?: number;
}

const DEFAULT_KEEP_ALIVE_MS = 15_000;

/**
 * Attach a new SSE stream for `req`. Writes the SSE preamble,
 * subscribes to `registry`, and forwards every event until the
 * client disconnects. Returns a function that the caller can
 * invoke to force-close the stream (used by the server's close()
 * lifecycle).
 */
export function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  registry: LocalUiRegistry,
  options: SseOptions = {},
): () => void {
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;

  // 200 + SSE content-type. Leave CORS / auth headers alone —
  // the security policy already set them on the way in.
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Explicit message framing hint for browsers behind proxies
    // that buffer by default. Harmless when unused.
    'x-accel-buffering': 'no',
  });

  // Initial hello — lets the client know the stream is live
  // before any UI event fires. Studio uses this to flip its
  // status indicator to "live."
  res.write(`event: hello\ndata: {"ok":true}\n\n`);

  const unsubscribe = registry.subscribe((event: UiRegistryEvent) => {
    try {
      res.write(`event: ui\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Client already went away; the `close` listener below
      // runs the full unsub.
    }
  });

  const keepAlive = keepAliveMs > 0
    ? setInterval(() => {
        try {
          res.write(`:keep-alive\n\n`);
        } catch {
          // Same as above — let the close handler clean up.
        }
      }, keepAliveMs)
    : null;
  if (keepAlive) keepAlive.unref?.();

  function closeStream(): void {
    unsubscribe();
    if (keepAlive) clearInterval(keepAlive);
    try {
      res.end();
    } catch {
      // Already ended.
    }
  }

  req.on('close', closeStream);
  req.on('aborted', closeStream);
  res.on('close', closeStream);

  return closeStream;
}
