/**
 * InProcessStreamFanout — reference {@link StreamFanout} for OSS. One
 * process, in-memory subscriber registry, synchronous publish-to-queue.
 *
 * Each subscriber owns a tiny async-queue: publishes enqueue; the
 * iterator dequeues and yields. Abandoned iterators (consumer drops
 * the for-await) clean up on their next pull (the GC'd `return()`
 * hook) OR on `close(renderId)`.
 *
 * Production hosted-side binding (Redis pub/sub) lives in a closed
 * Redis adapter package. Any binding MUST pass `streamFanoutContract`.
 */
import type {
  StreamFanout,
  StreamFanoutPublishInput,
} from '../stream-fanout.js';
import type { BufferedStreamEnvelope } from '../session-stream-buffer.js';

/** One live subscription. */
interface Subscriber {
  /** Envelopes waiting to be yielded. FIFO. */
  queue: BufferedStreamEnvelope[];
  /** If the iterator is parked awaiting a frame, this resolves it. */
  waiter: ((value: IteratorResult<BufferedStreamEnvelope>) => void) | null;
  /** Set when `close()` fires for this renderId or the iterator is returned. */
  closed: boolean;
}

export class InProcessStreamFanout implements StreamFanout {
  private readonly subscribersByRender = new Map<string, Set<Subscriber>>();

  async publish(input: StreamFanoutPublishInput): Promise<void> {
    const { renderId, envelope } = input;
    const subs = this.subscribersByRender.get(renderId);
    if (!subs || subs.size === 0) return;
    for (const sub of subs) {
      if (sub.closed) continue;
      // Parked waiter? Resolve it directly — no queue hop.
      if (sub.waiter !== null) {
        const resolve = sub.waiter;
        sub.waiter = null;
        resolve({ value: envelope, done: false });
      } else {
        sub.queue.push(envelope);
      }
    }
  }

  subscribe(renderId: string): AsyncIterable<BufferedStreamEnvelope> {
    const sub: Subscriber = { queue: [], waiter: null, closed: false };

    // Eager registration — the Protocol Bar promises delivery of every
    // frame published strictly AFTER subscribe-return. Registering here
    // (synchronously as part of the subscribe() call) is what makes that
    // promise keepable: by the time the returned AsyncIterable is handed
    // back, the subscriber is already in `subscribersByRender`, so the
    // very next `publish()` will observe it.
    let set = this.subscribersByRender.get(renderId);
    if (!set) {
      set = new Set();
      this.subscribersByRender.set(renderId, set);
    }
    set.add(sub);
    let registered = true;

    const unregister = (): void => {
      sub.closed = true;
      // Unpark any waiter with done:true.
      if (sub.waiter !== null) {
        const resolve = sub.waiter;
        sub.waiter = null;
        resolve({ value: undefined, done: true });
      }
      if (!registered) return;
      const liveSet = this.subscribersByRender.get(renderId);
      if (liveSet) {
        liveSet.delete(sub);
        if (liveSet.size === 0) this.subscribersByRender.delete(renderId);
      }
      registered = false;
    };

    // Arrow-function iterator methods so `this` still resolves to the
    // lexical closure (unregister captures it). The class-property
    // equivalent would require binding in every method; this is tighter.
    const iterator: AsyncIterator<BufferedStreamEnvelope> = {
      next: async (): Promise<IteratorResult<BufferedStreamEnvelope>> => {
        if (sub.closed) return { value: undefined, done: true };
        const queued = sub.queue.shift();
        if (queued !== undefined) return { value: queued, done: false };
        return new Promise<IteratorResult<BufferedStreamEnvelope>>(
          (resolve) => {
            sub.waiter = resolve;
          },
        );
      },
      return: async (): Promise<IteratorResult<BufferedStreamEnvelope>> => {
        unregister();
        return { value: undefined, done: true };
      },
      throw: async (
        err?: unknown,
      ): Promise<IteratorResult<BufferedStreamEnvelope>> => {
        unregister();
        throw err;
      },
    };

    return {
      [Symbol.asyncIterator]: (): AsyncIterator<BufferedStreamEnvelope> =>
        iterator,
    };
  }

  async close(renderId: string): Promise<void> {
    const subs = this.subscribersByRender.get(renderId);
    if (!subs) return;
    for (const sub of subs) {
      sub.closed = true;
      if (sub.waiter !== null) {
        const resolve = sub.waiter;
        sub.waiter = null;
        resolve({ value: undefined, done: true });
      }
    }
    this.subscribersByRender.delete(renderId);
  }

  /** Debug / test-only — current subscriber count for this render. */
  subscriberCount(renderId: string): number {
    return this.subscribersByRender.get(renderId)?.size ?? 0;
  }
}
