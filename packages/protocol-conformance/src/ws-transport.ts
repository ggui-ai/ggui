/**
 * Minimal WebSocket transport for the conformance runner.
 *
 * Opens a live-channel connection to a ggui-protocol server (SPEC §12.2),
 * sends subscribe + action frames verbatim, and exposes an async
 * `observe()` that collects inbound frames into a buffer for the
 * matcher.
 *
 * Scope discipline: this file is the `kind: 'ws'` arm of
 * `TransportConfig`. Post-v1.1 transports (stdio MCP, HTTP long-poll)
 * land as sibling modules with the same `Transport` shape. The
 * transport is NOT a full MCP client — it does not try to be
 * compatible with the MCP SDK, and it does not implement stack
 * management. The kit runs against an already-provisioned render
 * (the host's `create-render` setup step ran first) and treats the
 * wire as opaque after that.
 *
 * Auth:
 *   - `bearer` token → `Authorization: Bearer <token>` header on
 *     the upgrade request.
 *   - `session-cookie` → `Cookie: <cookie>` header.
 */
import WebSocket, { type RawData } from 'ws';

import type { AuthConfig, WebSocketTransportConfig } from './types.js';

/**
 * One observed frame. Preserves the raw bytes + the parsed shape so
 * matchers can assert on either. Parse errors surface as `kind:
 * 'unparseable'` — the kit never swallows them.
 */
export type ObservedFrame =
  | { readonly kind: 'frame'; readonly raw: string; readonly parsed: Record<string, unknown> }
  | { readonly kind: 'unparseable'; readonly raw: string; readonly error: string };

/**
 * Opaque handle returned by {@link openWsTransport}. Closed explicitly
 * via {@link WsTransport.close} — the runner closes after each
 * fixture so renders don't leak between cases.
 */
export interface WsTransport {
  /** Send one frame over the wire. Serializes `frame` as JSON. */
  send(frame: unknown): void;
  /**
   * Collect every frame that arrives within `timeoutMs`. Resolves
   * with the buffered frames when the timeout elapses, or earlier if
   * `predicate` is provided and matches a frame.
   */
  observe(options: {
    readonly timeoutMs: number;
    readonly predicate?: (frame: ObservedFrame) => boolean;
  }): Promise<readonly ObservedFrame[]>;
  /** Close the socket. Idempotent. */
  close(): Promise<void>;
}

/**
 * Open a WS transport against `config.url`, wait for the socket to
 * reach `OPEN` state, and return the transport handle. Throws if the
 * socket errors or closes before reaching OPEN.
 */
export async function openWsTransport(
  config: WebSocketTransportConfig,
): Promise<WsTransport> {
  const headers = authHeaders(config.auth);
  const socket = new WebSocket(config.url, { headers });

  const buffer: ObservedFrame[] = [];
  let flushWaiter: ((frame: ObservedFrame) => void) | null = null;

  socket.on('message', (raw: RawData) => {
    const text = raw.toString('utf8');
    const parsed = safeParse(text);
    const frame: ObservedFrame =
      parsed.ok === true
        ? { kind: 'frame', raw: text, parsed: parsed.value }
        : { kind: 'unparseable', raw: text, error: parsed.error };
    buffer.push(frame);
    // Fire any pending observer synchronously so predicate-driven
    // early-return works without a polling loop.
    const waiter = flushWaiter;
    if (waiter !== null) {
      flushWaiter = null;
      waiter(frame);
    }
  });

  await new Promise<void>((done, fail) => {
    const onOpen = (): void => {
      socket.off('error', onError);
      socket.off('close', onClose);
      done();
    };
    const onError = (err: Error): void => {
      socket.off('open', onOpen);
      socket.off('close', onClose);
      fail(err);
    };
    const onClose = (code: number, reason: Buffer): void => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      fail(
        new Error(
          `protocol-conformance: ws closed before open — code=${code} reason=${reason.toString('utf8')}`,
        ),
      );
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });

  return {
    send(frame: unknown): void {
      socket.send(JSON.stringify(frame));
    },

    async observe({ timeoutMs, predicate }): Promise<readonly ObservedFrame[]> {
      // Drain any already-buffered frames first; the timeout only
      // bounds the wait for NEW frames.
      if (predicate !== undefined) {
        const existing = buffer.find((f) => predicate(f));
        if (existing !== undefined) return snapshot(buffer);
      }
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          flushWaiter = null;
          done();
        }, timeoutMs);

        const onFrame = (frame: ObservedFrame): void => {
          if (predicate !== undefined && predicate(frame)) {
            clearTimeout(timer);
            done();
            return;
          }
          flushWaiter = onFrame;
        };
        flushWaiter = onFrame;
      });
      return snapshot(buffer);
    },

    async close(): Promise<void> {
      if (
        socket.readyState === WebSocket.CLOSED ||
        socket.readyState === WebSocket.CLOSING
      ) {
        return;
      }
      await new Promise<void>((done) => {
        socket.once('close', () => done());
        socket.close();
      });
    },
  };
}

// =============================================================================
// Helpers
// =============================================================================

function authHeaders(auth: AuthConfig): Record<string, string> {
  switch (auth.kind) {
    case 'bearer':
      return { Authorization: `Bearer ${auth.token}` };
    case 'session-cookie':
      return { Cookie: auth.cookie };
  }
}

function safeParse(
  text: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'frame is not a JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

function snapshot(buffer: readonly ObservedFrame[]): readonly ObservedFrame[] {
  return buffer.slice();
}
