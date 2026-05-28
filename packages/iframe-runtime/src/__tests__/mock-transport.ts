/**
 * In-process `Transport` test double for driving `App.connect` /
 * `App.callServerTool` / `App.readServerResource` / inbound
 * notifications without `window.postMessage`.
 *
 * Implements the SDK's `Transport` contract from
 * `@modelcontextprotocol/sdk/shared/transport.js` — once `start()`
 * resolves the App invokes `send(message)` for every outbound
 * JSON-RPC envelope; we inspect the method and respond from a
 * caller-queued reply.
 *
 * Why a test double instead of {@link PostMessageTransport}: the spec
 * tests for `bootSequence` need deterministic control over BOTH halves
 * of the conversation (the `ui/initialize` response shape, the
 * arrival timing of `ui/notifications/tool-result` notifications,
 * tool-call replies, error injection). `PostMessageTransport` requires
 * a real `window` and another peer to drive — too brittle for the
 * orchestration smoke this layer needs.
 *
 * Usage:
 * ```ts
 * const transport = new MockTransport();
 * transport.queueResponse('ui/initialize', {
 *   result: { protocolVersion, hostInfo, hostCapabilities, hostContext: {} },
 * });
 * const app = new App({ name: 'test', version: '1' }, {}, { autoResize: false });
 * await app.connect(transport);
 * // ...later, push an inbound notification:
 * transport.pushNotification({
 *   method: 'ui/notifications/tool-result',
 *   params: { _meta: { 'ai.ggui/render': {...} } },
 * });
 * ```
 */
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';

/**
 * Reply factory for a queued response — receives the outbound request
 * id so the reply echoes it correctly. Used internally by
 * {@link MockTransport.queueResponse}.
 */
type QueuedReplyFactory = (requestId: number | string) => JSONRPCMessage;

interface QueuedReply {
  readonly method: string;
  readonly buildReply: QueuedReplyFactory;
}

export interface QueueResponseOptions {
  /**
   * Synthesize the reply from the outbound request. Default: echo the
   * supplied `result` as `{jsonrpc: '2.0', id, result}`.
   */
  readonly result?: unknown;
  /** Synthesize an error reply. Default: undefined (use `result`). */
  readonly error?: { readonly code?: number; readonly message: string };
}

export class MockTransport implements Transport {
  private started = false;
  private closed = false;

  /** Reply queue keyed by method. FIFO per method. */
  private readonly replies = new Map<string, QueuedReply[]>();

  /** Outbound message capture — every payload sent by the bound peer. */
  public readonly sent: JSONRPCMessage[] = [];

  /**
   * Records every request method observed inbound. Useful to assert
   * "the bound App fired ui/initialize" without a deep dive into the
   * full payload.
   */
  public readonly methodsSeen: string[] = [];

  onclose: (() => void) | undefined;
  onerror: ((err: Error) => void) | undefined;
  onmessage:
    | (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void)
    | undefined;

  sessionId: string | undefined;

  setProtocolVersion: ((version: string) => void) | undefined = () => {
    /* no-op for tests */
  };

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('MockTransport.start() called twice');
    }
    this.started = true;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) throw new Error('MockTransport.send() after close');
    this.sent.push(message);

    // Drive the App by replying to requests asynchronously. Notifications
    // (no `id` field) are sent fire-and-forget — no reply expected. We
    // detect requests by the presence of `id` AND `method`.
    const bag = message as { id?: unknown; method?: unknown };
    const hasId = typeof bag.id === 'number' || typeof bag.id === 'string';
    if (typeof bag.method === 'string') {
      this.methodsSeen.push(bag.method);
    }
    if (!hasId || typeof bag.method !== 'string') return;

    const queued = this.replies.get(bag.method);
    if (queued === undefined || queued.length === 0) return;
    const reply = queued.shift();
    if (reply === undefined) return;
    const out = reply.buildReply(bag.id as number | string);
    // Deliver asynchronously to mirror the postMessage hop — the bound
    // App's `request()` awaits via its protocol layer; an immediate
    // synchronous `onmessage()` would race the promise's bookkeeping.
    queueMicrotask(() => {
      if (this.onmessage !== undefined) this.onmessage(out);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.onclose !== undefined) this.onclose();
  }

  /**
   * Queue a reply for the next request matching {@link method}. Default
   * builds `{jsonrpc:'2.0', id, result}` from {@link QueueResponseOptions.result}.
   * When {@link QueueResponseOptions.error} is set, builds the error
   * envelope instead.
   */
  queueResponse(method: string, opts: QueueResponseOptions): void {
    const list = this.replies.get(method) ?? [];
    const buildReply: QueuedReplyFactory = (id) => {
      if (opts.error !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: opts.error.code ?? -32000,
            message: opts.error.message,
          },
        } as JSONRPCMessage;
      }
      return {
        jsonrpc: '2.0',
        id,
        result: opts.result ?? {},
      } as JSONRPCMessage;
    };
    list.push({ method, buildReply });
    this.replies.set(method, list);
  }

  /**
   * Push an inbound notification to the bound peer. Used to simulate
   * host-initiated notifications like `ui/notifications/tool-result`
   * or `ui/notifications/host-context-changed`.
   *
   * Delivered synchronously — tests that want async ordering should
   * await a `queueMicrotask` cycle after calling this.
   */
  pushNotification(notification: {
    readonly method: string;
    readonly params?: unknown;
  }): void {
    if (this.onmessage === undefined) return;
    const envelope = {
      jsonrpc: '2.0',
      method: notification.method,
      params: notification.params,
    } as JSONRPCMessage;
    this.onmessage(envelope);
  }
}
