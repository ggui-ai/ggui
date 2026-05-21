/**
 * SSE consumer for `GET /threads/:id/stream`.
 *
 * We use `fetch` + `ReadableStream` rather than the browser's
 * `EventSource` because:
 *
 *   1. Bearer-token auth is required; `EventSource` cannot set custom
 *      request headers by spec. Cookies aren't a fit for a paired-
 *      token trust model.
 *   2. fetch streaming is supported on modern web AND on React Native
 *      0.73+ / Hermes (Expo SDK 50+).
 *   3. The server already writes `data:` as JSON-encoded
 *      ThreadStreamEvent; consumer parsing is a few lines.
 *
 * The returned disposer aborts the fetch, which on both runtimes
 * propagates into closing the underlying socket. That in turn makes
 * the server's `res.on('close')` handler fire, which disposes the
 * store iterator — no resource leak.
 *
 * Error handling: fatal per-frame parse failures are swallowed (a
 * bad frame shouldn't kill the stream); transport-level read
 * failures surface via `onError` once, then the reader returns.
 */
import type { ThreadStreamEvent } from '@ggui-ai/protocol';
import { isThreadStreamEvent } from '@ggui-ai/protocol';
import { ThreadTransportError } from './errors.js';

export interface OpenThreadStreamOptions {
  readonly baseUrl: string;
  readonly path: string;
  readonly pairingToken: string;
  /** Injected EventSource-ish override. Unused today but preserved
   *  so a future RN-native SSE library slots in without API churn. */
  readonly eventSource?: typeof EventSource;
  readonly fetch?: typeof fetch;
  readonly onEvent: (event: ThreadStreamEvent) => void;
  readonly onError?: (err: Error) => void;
}

export function openThreadStream(opts: OpenThreadStreamOptions): () => void {
  const controller = new AbortController();
  const fetchFn = opts.fetch ?? globalThis.fetch;

  void (async () => {
    let resp: Response;
    try {
      resp = await fetchFn(opts.baseUrl + opts.path, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${opts.pairingToken}`,
          accept: 'text/event-stream',
          'cache-control': 'no-cache',
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      opts.onError?.(
        err instanceof Error ? err : new Error(String(err)),
      );
      return;
    }

    if (!resp.ok) {
      opts.onError?.(
        new ThreadTransportError({
          message: `Thread stream request failed (${resp.status})`,
          status: resp.status,
          code: 'stream_open_failed',
        }),
      );
      return;
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      opts.onError?.(
        new ThreadTransportError({
          message: 'Thread stream response has no readable body',
          status: resp.status,
          code: 'stream_no_body',
        }),
      );
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = parseFrame(frame);
          if (event) opts.onEvent(event);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      opts.onError?.(
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      reader.cancel().catch(() => undefined);
    }
  })();

  return () => {
    try {
      controller.abort();
    } catch {
      // ignore — abort is best-effort cleanup
    }
  };
}

/**
 * Parse a single SSE frame (one logical event, terminated by `\n\n`
 * at the caller side). Returns a `ThreadStreamEvent` when the frame
 * is a well-formed `event: thread-message` carrying a JSON-encoded
 * ThreadStreamEvent payload. Returns null for comment frames,
 * heartbeats, unknown event types, or malformed payloads — those
 * shouldn't kill the stream.
 */
function parseFrame(frame: string): ThreadStreamEvent | null {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // Multi-line `data:` fields concatenate — spec compliance even
      // though the server emits single-line frames today.
      data += (data ? '\n' : '') + line.slice(5).trim();
    }
    // `id:` and `retry:` ignored; server uses `id:` for seq but the
    // consumer already has seq on the parsed payload.
  }
  if (event !== 'thread-message' || data === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isThreadStreamEvent(parsed) ? parsed : null;
}
