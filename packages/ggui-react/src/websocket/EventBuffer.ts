import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';

/**
 * Configuration for {@link EventBuffer}.
 */
export interface EventBufferOptions {
  maxSize?: number;
  /** Called when the buffer is full and oldest messages are dropped */
  onOverflow?: (dropped: WebSocketMessage) => void;
}

/**
 * Buffer for queuing messages when WebSocket is disconnected
 */
export class EventBuffer {
  private buffer: WebSocketMessage[] = [];
  private maxSize: number;
  private onOverflow?: (dropped: WebSocketMessage) => void;

  constructor(options?: number | EventBufferOptions) {
    if (typeof options === 'number') {
      this.maxSize = options;
    } else {
      this.maxSize = options?.maxSize ?? 500;
      this.onOverflow = options?.onOverflow;
    }
  }

  /**
   * Add a message to the buffer. Drops the oldest message if the buffer
   * is full, logging a warning and invoking the optional `onOverflow` callback.
   *
   * @param message - The WebSocket message to buffer
   */
  add(message: WebSocketMessage): void {
    if (this.buffer.length >= this.maxSize) {
      const dropped = this.buffer.shift();
      if (dropped) {
        console.warn(
          `[ggui] EventBuffer overflow: dropping oldest message (type="${dropped.type}"). ` +
          `Buffer is full at ${this.maxSize} messages.`
        );
        this.onOverflow?.(dropped);
      }
    }
    this.buffer.push(message);
  }

  /**
   * Drain all buffered messages and return them in order.
   *
   * @returns Array of buffered messages (buffer is cleared after this call)
   */
  flush(): WebSocketMessage[] {
    const messages = [...this.buffer];
    this.buffer = [];
    return messages;
  }

  /**
   * Return the current number of buffered messages.
   */
  size(): number {
    return this.buffer.length;
  }
}
