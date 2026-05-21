import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';

const PERSIST_KEY = 'ggui_event_buffer';

/**
 * Configuration for {@link EventBuffer}.
 */
export interface EventBufferOptions {
  maxSize?: number;
  /** Called when the buffer is full and oldest messages are dropped */
  onOverflow?: (dropped: WebSocketMessage) => void;
}

/**
 * Buffer for queuing messages when WebSocket is disconnected.
 * On mobile, this is especially important during network transitions.
 *
 * Enhanced with:
 * - AsyncStorage persistence (survives app restarts)
 * - Deduplication by type+payload hash
 */
export class EventBuffer {
  private buffer: WebSocketMessage[] = [];
  private maxSize: number;
  private onOverflow?: (dropped: WebSocketMessage) => void;
  private seen = new Set<string>();
  private storage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  } | null = null;

  constructor(options?: number | EventBufferOptions) {
    if (typeof options === 'number') {
      this.maxSize = options;
    } else {
      this.maxSize = options?.maxSize ?? 500;
      this.onOverflow = options?.onOverflow;
    }
  }

  /**
   * Attach an AsyncStorage-compatible backend for persistence.
   * Call this once during initialization.
   */
  setStorage(storage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  }): void {
    this.storage = storage;
  }

  /**
   * Load persisted events from storage (call on init).
   */
  async loadPersisted(): Promise<void> {
    if (!this.storage) return;
    try {
      const raw = await this.storage.getItem(PERSIST_KEY);
      if (!raw) return;
      const messages = JSON.parse(raw) as WebSocketMessage[];
      for (const msg of messages) {
        const key = this.dedupeKey(msg);
        if (!this.seen.has(key)) {
          this.seen.add(key);
          this.buffer.push(msg);
        }
      }
    } catch {
      // Persistence failures are non-critical
    }
  }

  /**
   * Add a message to the buffer with deduplication.
   *
   * Skips messages already in the buffer (by type+payload hash). Drops
   * the oldest message if the buffer is full. Persists to storage if
   * configured.
   *
   * @param message - The WebSocket message to buffer
   */
  add(message: WebSocketMessage): void {
    const key = this.dedupeKey(message);
    if (this.seen.has(key)) return; // Deduplicate
    this.seen.add(key);

    if (this.buffer.length >= this.maxSize) {
      const removed = this.buffer.shift();
      if (removed) {
        this.seen.delete(this.dedupeKey(removed));
        console.warn(
          `[ggui] EventBuffer overflow: dropping oldest message (type="${removed.type}"). ` +
          `Buffer is full at ${this.maxSize} messages.`
        );
        this.onOverflow?.(removed);
      }
    }
    this.buffer.push(message);
    this.persist();
  }

  /**
   * Drain all buffered messages and return them in order.
   * Clears the deduplication set and removes persisted data.
   *
   * @returns Array of buffered messages
   */
  flush(): WebSocketMessage[] {
    const messages = [...this.buffer];
    this.buffer = [];
    this.seen.clear();
    this.clearPersisted();
    return messages;
  }

  /**
   * Return the current number of buffered messages.
   */
  size(): number {
    return this.buffer.length;
  }

  private dedupeKey(msg: WebSocketMessage): string {
    return `${msg.type}:${JSON.stringify(msg.payload)}`;
  }

  private persist(): void {
    if (!this.storage) return;
    this.storage.setItem(PERSIST_KEY, JSON.stringify(this.buffer)).catch(() => {});
  }

  private clearPersisted(): void {
    if (!this.storage) return;
    this.storage.removeItem(PERSIST_KEY).catch(() => {});
  }
}
