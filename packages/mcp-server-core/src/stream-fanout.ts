/**
 * StreamFanout — pub/sub seam for live-channel stream delivery across
 * publisher→subscriber boundaries. It lets the live-channel
 * server delegate fanout to an injectable implementation: in-process
 * for OSS, Redis pub/sub for hosted deployments (where publisher and
 * subscriber may live on different pods).
 *
 * ## Protocol & Contract Bar
 *
 * **Parties:**
 * - Producer: the server code path that emits live-channel frames
 *   (e.g., the `ggui_emit` tool handler, `ggui_update` handlers, the
 *   server's reserved `_ggui:lifecycle` emitter). The producer
 *   calls {@link StreamFanout.publish} AFTER the envelope has been stamped
 *   with its buffer-assigned `seq` (see {@link BufferedStreamEnvelope}).
 * - Consumer: the subscriber-side glue that forwards frames to concrete
 *   transports. In OSS: the live-channel server (`ggui-session-channel.ts`
 *   in `@ggui-ai/mcp-server`) pumps the async iterator
 *   into each live WebSocket subscriber. In hosted: `bridge-gateway`
 *   pod pumps Redis pub/sub messages into API-Gateway WS connections.
 *
 * **Obligations:**
 * - Producer MUST call `publish()` at most once per envelope per render.
 *   The envelope MUST carry a `sessionId` that matches the routing key
 *   and a `seq` that is strictly increasing for the render (gap-free
 *   for a single writer; gaps across concurrent writers surface as
 *   sequence conflicts upstream at the `GguiSessionStreamBuffer.record`
 *   layer, not here).
 * - Consumer `subscribe()` MUST deliver every frame that `publish()`
 *   completes AFTER the subscribe call returns. Frames published
 *   BEFORE subscribe-return MAY be missed — this seam is live-tail
 *   only; gap-recovery for reconnecting subscribers is the
 *   {@link GguiSessionStreamBuffer.replay} path's responsibility.
 * - Implementations MUST NOT coalesce, drop, or reorder publishes
 *   within a render. Multi-subscriber fanout within a single render
 *   MUST see all frames in the same sequence order.
 * - Implementations MUST tolerate subscriber iterator abandonment
 *   without leaking: dropping the iterator (or calling its `return()`)
 *   MUST unregister the subscriber within a bounded time.
 *
 * **Failure mode:**
 * - `publish()` failure (network, backpressure, internal error) MUST
 *   throw. Producers decide retry policy; the live-channel server treats a
 *   thrown publish as a log-and-continue event because the envelope
 *   has already been persisted to the {@link GguiSessionStreamBuffer} and
 *   will be recovered on the next subscriber reconnect.
 * - `subscribe()` iterator termination (consumer drop, network drop,
 *   upstream `close()`) MUST end the async iterator cleanly (return
 *   `{done: true}`). Consumers detect termination and reconnect via
 *   replay.
 * - `close(sessionId)` MUST cause all in-flight subscribers for that
 *   render to terminate cleanly. It is idempotent.
 *
 * **Observable violation:**
 * - Contract test `streamFanoutContract(impl)` covers: single publish
 *   delivered to single subscriber; 1000 publishes delivered in-order;
 *   multi-subscriber fanout consistency; concurrent producer
 *   interleave; close() drains subscribers; subscribe-after-publish
 *   miss semantics.
 *
 * ## Relationship to other seams
 *
 * - {@link GguiSessionStreamBuffer} — stores envelopes for replay on reconnect.
 *   StreamFanout is the LIVE channel; replay is the HISTORY channel.
 *   A typical emitter path: `buffer.record(delivery)` → get
 *   BufferedStreamEnvelope → `fanout.publish({sessionId, envelope})`.
 * - {@link GguiSessionStore} — durable render state. Orthogonal; fanout
 *   carries data to live subscribers, GguiSessionStore persists it.
 *
 * ## OSS default + hosted binding
 *
 * OSS default: `InProcessStreamFanout` (from `@ggui-ai/mcp-server-core/in-memory`).
 *
 * Hosted binding (Path A): a Redis-backed implementation in a closed
 * adapter package. Key pattern: `ggui:stream:<sessionId>`; payload is
 * the JSON-encoded {@link BufferedStreamEnvelope}; close fires a
 * close-marker record that subscribers recognize and unwind.
 */
import type { BufferedStreamEnvelope } from './ggui-session-stream-buffer.js';

/**
 * Input to {@link StreamFanout.publish}. Flat-object shape for easy
 * extension (future fields would go here without breaking the signature).
 */
export interface StreamFanoutPublishInput {
  /** GguiSession this frame belongs to. Routing key for fanout. */
  readonly sessionId: string;
  /**
   * The buffered envelope — already seq-stamped and schemaVersion-tagged
   * by {@link GguiSessionStreamBuffer.record}. StreamFanout does NOT stamp or
   * mutate; it routes exactly what was handed in.
   */
  readonly envelope: BufferedStreamEnvelope;
}

/**
 * Live-tail pub/sub for live-channel delivery. See file docstring for the
 * full Protocol & Contract Bar semantics.
 */
export interface StreamFanout {
  /**
   * Publish one envelope to this render's live subscribers. Delivery
   * is fire-and-forget from the producer's perspective: the returned
   * promise resolves when the publish has been committed to the
   * underlying pub/sub layer, NOT when every subscriber has received
   * it.
   *
   * MUST throw on publish failure (backpressure, network, etc.).
   */
  publish(input: StreamFanoutPublishInput): Promise<void>;

  /**
   * Subscribe to this render's live frames. The returned async
   * iterator yields every envelope that `publish()` completes strictly
   * AFTER this call returns.
   *
   * Iterator termination is driven by:
   *   - Consumer abandoning the iterator (or calling its `return()`) —
   *     subscriber is unregistered within bounded time.
   *   - Upstream calling {@link StreamFanout.close} for the render —
   *     iterator ends with `{done: true}`.
   *   - Implementation-detected error (Redis disconnect, etc.) —
   *     iterator throws; consumer reconnects via `GguiSessionStreamBuffer.replay`.
   */
  subscribe(sessionId: string): AsyncIterable<BufferedStreamEnvelope>;

  /**
   * Terminate all in-flight subscribers for this render. Typically
   * called when a render is deleted or its TTL expires so subscribers
   * don't leak. Idempotent; calling `close` on a render with no
   * subscribers is a no-op.
   */
  close(sessionId: string): Promise<void>;
}
