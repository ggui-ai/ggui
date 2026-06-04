/**
 * Tests for `SqlitePendingEventConsumer` — file-backed (`:memory:`)
 * variant. Mirrors the InMemory test suite to prove both impls
 * satisfy the same `PendingEventConsumer` contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqlitePendingEventConsumer } from './pending-event-consumer.js';
import { PendingPipeNotFoundError } from '../pending-event-consumer.js';

describe('SqlitePendingEventConsumer', () => {
  let consumer: SqlitePendingEventConsumer;

  beforeEach(() => {
    // `:memory:` for test isolation — each test gets a fresh database.
    consumer = new SqlitePendingEventConsumer({ filename: ':memory:' });
  });

  afterEach(() => {
    consumer.close();
  });

  describe('lifecycle hooks', () => {
    it('markCreated registers a render — subsequent appends + consumes work', async () => {
      consumer.markCreated('render-1');
      await consumer.append('render-1', { id: 'evt-1', type: 'foo' });
      const result = await consumer.consumeAndClear('render-1', 60_000);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('evt-1');
      expect(result.status).toBe('active');
    });

    it('markCreated is idempotent — calling twice does NOT reset', async () => {
      consumer.markCreated('render-1');
      await consumer.append('render-1', { id: 'evt-1' });
      consumer.markCreated('render-1'); // no-op
      const result = await consumer.consumeAndClear('render-1', 60_000);
      expect(result.events).toHaveLength(1);
    });

  });

  describe('consumeAndClear', () => {
    it('returns events present at clear time, then leaves the buffer empty', async () => {
      consumer.markCreated('render-1');
      await consumer.append('render-1', { id: 'a' });
      await consumer.append('render-1', { id: 'b' });
      const first = await consumer.consumeAndClear('render-1', 60_000);
      expect(first.events.map((e) => e.id)).toEqual(['a', 'b']);
      const second = await consumer.consumeAndClear('render-1', 60_000);
      expect(second.events).toEqual([]);
    });

    it('throws PendingPipeNotFoundError when the render never existed', async () => {
      await expect(
        consumer.consumeAndClear('never-created', 60_000),
      ).rejects.toBeInstanceOf(PendingPipeNotFoundError);
    });

    it('returns empty array + active status when buffer is empty', async () => {
      consumer.markCreated('render-1');
      const result = await consumer.consumeAndClear('render-1', 60_000);
      expect(result.events).toEqual([]);
      expect(result.status).toBe('active');
    });
  });

  describe('append', () => {
    it('throws PendingPipeNotFoundError when render never registered', async () => {
      await expect(
        consumer.append('never', { id: 'evt-1' }),
      ).rejects.toBeInstanceOf(PendingPipeNotFoundError);
    });

    it('FIFO ordering — sequential appends preserve order on consume', async () => {
      consumer.markCreated('render-1');
      await consumer.append('render-1', { id: 'first' });
      await consumer.append('render-1', { id: 'second' });
      await consumer.append('render-1', { id: 'third' });
      const result = await consumer.consumeAndClear('render-1', 60_000);
      expect(result.events.map((e) => e.id)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('seq resets after consume — next append starts at 1 again', async () => {
      consumer.markCreated('render-1');
      await consumer.append('render-1', { id: 'a' });
      await consumer.consumeAndClear('render-1', 60_000);
      // Drained. Next append should land cleanly.
      await consumer.append('render-1', { id: 'b' });
      const result = await consumer.consumeAndClear('render-1', 60_000);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('b');
    });
  });

  describe('persistence (multiple consumer instances)', () => {
    it('shares state across instances pointing at the same file', async () => {
      // The default `:memory:` is per-connection. Use a temp file path
      // to demonstrate persistence semantics.
      const tmpPath = `/tmp/ggui-pending-events-test-${Date.now()}-${Math.random()}.sqlite`;
      const a = new SqlitePendingEventConsumer({ filename: tmpPath });
      a.markCreated('render-1');
      await a.append('render-1', { id: 'persistent' });
      a.close();

      const b = new SqlitePendingEventConsumer({ filename: tmpPath });
      const result = await b.consumeAndClear('render-1', 60_000);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('persistent');
      b.close();
    });
  });

  describe('inspector helpers', () => {
    it('pendingCount reports buffer size without consuming', async () => {
      consumer.markCreated('render-1');
      expect(consumer.pendingCount('render-1')).toBe(0);
      await consumer.append('render-1', { id: 'a' });
      await consumer.append('render-1', { id: 'b' });
      expect(consumer.pendingCount('render-1')).toBe(2);
      expect(consumer.pendingCount('render-1')).toBe(2);
    });

    it('pendingCount returns 0 for a render that doesn\'t exist (no throw)', () => {
      expect(consumer.pendingCount('does-not-exist')).toBe(0);
    });
  });
});
