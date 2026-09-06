/**
 * `PendingEventConsumer` conformance runner — Slice 5.1 second cut.
 *
 * Invokes the shared conformance suite against both OSS impls. The
 * cloud `DynamoPendingEventConsumer` adapter (wraps the cloud DDB
 * `consumePendingEvents` primitive) plugs into the suite from its own
 * test file once a DDB mock is set up.
 *
 * See `./pending-event-consumer.conformance.ts` for the suite itself.
 */
import { InMemoryPendingEventConsumer } from '../in-memory/pending-event-consumer.js';
import { SqlitePendingEventConsumer } from '../sqlite/pending-event-consumer.js';
import Database from 'better-sqlite3';
import {
  runPendingEventConsumerConformance,
  runPendingEventStoreBoundaryConformance,
} from './pending-event-consumer.conformance.js';

runPendingEventConsumerConformance('InMemoryPendingEventConsumer', {
  create: async () => {
    const consumer = new InMemoryPendingEventConsumer();
    return {
      consumer,
      seed: (sessionId: string) => consumer.markCreated(sessionId),
    };
  },
});

runPendingEventConsumerConformance('SqlitePendingEventConsumer', {
  create: async () => {
    const consumer = new SqlitePendingEventConsumer({ filename: ':memory:' });
    return {
      consumer,
      seed: (sessionId: string) => consumer.markCreated(sessionId),
    };
  },
});


runPendingEventStoreBoundaryConformance('SqlitePendingEventConsumer', {
  create: async () => {
    const db = new Database(':memory:');
    const consumer = new SqlitePendingEventConsumer({ db });
    return {
      consumer,
      seed: (sessionId: string) => consumer.markCreated(sessionId),
      writeRawRow: (sessionId: string, row: unknown) => {
        const next = db
          .prepare<unknown[], { n: number }>(
            'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM pending_events WHERE render_id = ?',
          )
          .get(sessionId);
        db.prepare(
          'INSERT INTO pending_events (render_id, seq, event_json, enqueued_at) VALUES (?, ?, ?, ?)',
        ).run(sessionId, next?.n ?? 1, JSON.stringify(row), Date.now());
      },
      removeRawRow: (sessionId: string, id: string) => {
        db.prepare(
          "DELETE FROM pending_events WHERE render_id = ? AND json_extract(event_json, '$.id') = ?",
        ).run(sessionId, id);
      },
    };
  },
}, 'refuse');
