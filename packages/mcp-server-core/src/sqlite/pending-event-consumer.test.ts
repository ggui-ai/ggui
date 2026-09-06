/**
 * Tests for `SqlitePendingEventConsumer` — file-backed (`:memory:`)
 * variant. Mirrors the InMemory test suite to prove both impls
 * satisfy the same `PendingEventConsumer` contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqlitePendingEventConsumer } from './pending-event-consumer.js';
import { PendingPipeNotFoundError } from '../pending-event-consumer.js';
import type { PendingEvent } from '@ggui-ai/protocol';

/** A well-formed pipe row — `id` doubles as the intent so tests can tell rows apart. */
function row(id: string): PendingEvent {
  return {
    id,
    envelope: {
      type: 'action',
      sessionId: 'render-1',
      intent: id,
      actionData: null,
      uiContext: {},
      actionId: id,
      firedAt: '2026-09-05T00:00:00.000Z',
    },
    createdAt: '2026-09-05T00:00:00.000Z',
  };
}

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
      await consumer.append('render-1', row('evt-1'));
      const result = await consumer.consumeAndClear('render-1', 60_000);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe('evt-1');
      expect(result.status).toBe('active');
    });

    it('markCreated is idempotent — calling twice does NOT reset', async () => {
      consumer.markCreated('render-1');
      await consumer.append('render-1', row('evt-1'));
      consumer.markCreated('render-1'); // no-op
      const result = await consumer.consumeAndClear('render-1', 60_000);
      expect(result.events).toHaveLength(1);
    });

  });

  describe('consumeAndClear', () => {
    it('returns events present at clear time, then leaves the buffer empty', async () => {
      consumer.markCreated('render-1');
      await consumer.append('render-1', row('a'));
      await consumer.append('render-1', row('b'));
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
        consumer.append('never', row('evt-1')),
      ).rejects.toBeInstanceOf(PendingPipeNotFoundError);
    });

    it('FIFO ordering — sequential appends preserve order on consume', async () => {
      consumer.markCreated('render-1');
      await consumer.append('render-1', row('first'));
      await consumer.append('render-1', row('second'));
      await consumer.append('render-1', row('third'));
      const result = await consumer.consumeAndClear('render-1', 60_000);
      expect(result.events.map((e) => e.id)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('seq resets after consume — next append starts at 1 again', async () => {
      consumer.markCreated('render-1');
      await consumer.append('render-1', row('a'));
      await consumer.consumeAndClear('render-1', 60_000);
      // Drained. Next append should land cleanly.
      await consumer.append('render-1', row('b'));
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
      await a.append('render-1', row('persistent'));
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
      await consumer.append('render-1', row('a'));
      await consumer.append('render-1', row('b'));
      expect(consumer.pendingCount('render-1')).toBe(2);
      expect(consumer.pendingCount('render-1')).toBe(2);
    });

    it('pendingCount returns 0 for a render that doesn\'t exist (no throw)', () => {
      expect(consumer.pendingCount('does-not-exist')).toBe(0);
    });
  });
});

// ── ggui#405 — append idempotency per event.id (pipe lifetime) ─────────────

describe('append idempotency (ggui#405)', () => {
  it('a duplicate id is a silent no-op — even AFTER the original drained', async () => {
    const pipe = new SqlitePendingEventConsumer({ filename: ':memory:' });
    pipe.markCreated('s1');
    await pipe.append('s1', row('act-1'));
    await pipe.append('s1', row('act-1'));
    const first = await pipe.consumeAndClear('s1', 60_000);
    expect(first.events).toHaveLength(1);

    await pipe.append('s1', row('act-1'));
    const second = await pipe.consumeAndClear('s1', 60_000);
    expect(second.events).toHaveLength(0);
    pipe.close();
  });

  it('distinct ids append normally — the row type admits no id-less entry', async () => {
    const pipe = new SqlitePendingEventConsumer({ filename: ':memory:' });
    pipe.markCreated('s2');
    await pipe.append('s2', row('a'));
    await pipe.append('s2', row('b'));
    const res = await pipe.consumeAndClear('s2', 60_000);
    expect(res.events).toHaveLength(2);
    pipe.close();
  });
});

// ── ggui#839 — the drained row is the protocol's PendingEvent; malformed rows refuse at the store boundary

import Database from 'better-sqlite3';
import { expectTypeOf } from 'vitest';
import { PendingEventMalformedError } from '../pending-event-consumer.js';

describe('the store boundary (ggui#839)', () => {
  const ROW: PendingEvent = {
    id: 'act-1',
    envelope: {
      type: 'action',
      sessionId: 'render-1',
      intent: 'submit',
      actionData: null,
      uiContext: {},
      actionId: 'act-1',
      firedAt: '2026-09-05T00:00:00.000Z',
    },
    createdAt: '2026-09-05T00:00:00.000Z',
  };

  it('drains the row as a PendingEvent, not a free-form record', async () => {
    const consumer = new SqlitePendingEventConsumer({ filename: ':memory:' });
    consumer.markCreated('render-1');
    await consumer.append('render-1', ROW);
    const out = await consumer.consumeAndClear('render-1', 60_000);
    expectTypeOf(out.events).toEqualTypeOf<ReadonlyArray<PendingEvent>>();
    expect(out.events).toEqual([ROW]);
    consumer.close();
  });

  it('a row that fails the protocol schema rejects the drain with PendingEventMalformedError — and stays in the pipe', async () => {
    const db = new Database(':memory:');
    const consumer = new SqlitePendingEventConsumer({ db });
    consumer.markCreated('render-1');
    db.prepare(
      'INSERT INTO pending_events (render_id, seq, event_json, enqueued_at) VALUES (?, ?, ?, ?)',
    ).run('render-1', 1, JSON.stringify({ bogus: true }), Date.now());

    await expect(consumer.consumeAndClear('render-1', 60_000)).rejects.toMatchObject({
      name: 'PendingEventMalformedError',
      sessionId: 'render-1',
    });
    await expect(consumer.consumeAndClear('render-1', 60_000)).rejects.toBeInstanceOf(
      PendingEventMalformedError,
    );

    const left = db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM pending_events WHERE render_id = ?')
      .get('render-1');
    expect(left?.n).toBe(1);
    db.close();
  });

  it('names the row when its id was readable — rowId rides the error', async () => {
    const db = new Database(':memory:');
    const consumer = new SqlitePendingEventConsumer({ db });
    consumer.markCreated('render-1');
    db.prepare(
      'INSERT INTO pending_events (render_id, seq, event_json, enqueued_at) VALUES (?, ?, ?, ?)',
    ).run('render-1', 1, JSON.stringify({ id: 'row-9', bogus: true }), Date.now());
    await expect(consumer.consumeAndClear('render-1', 60_000)).rejects.toMatchObject({
      name: 'PendingEventMalformedError',
      sessionId: 'render-1',
      rowId: 'row-9',
    });
    db.close();
  });

  it('text that is not JSON refuses the same way — the store boundary is one gate', async () => {
    const db = new Database(':memory:');
    const consumer = new SqlitePendingEventConsumer({ db });
    consumer.markCreated('render-1');
    db.prepare(
      'INSERT INTO pending_events (render_id, seq, event_json, enqueued_at) VALUES (?, ?, ?, ?)',
    ).run('render-1', 1, 'not json', Date.now());

    await expect(consumer.consumeAndClear('render-1', 60_000)).rejects.toMatchObject({
      name: 'PendingEventMalformedError',
      sessionId: 'render-1',
      issues: [{ path: [], message: expect.stringContaining('not JSON') }],
    });
    db.close();
  });
});
