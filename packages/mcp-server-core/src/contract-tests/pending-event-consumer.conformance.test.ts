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
import { runPendingEventConsumerConformance } from './pending-event-consumer.conformance.js';

runPendingEventConsumerConformance('InMemoryPendingEventConsumer', {
  create: async () => {
    const consumer = new InMemoryPendingEventConsumer();
    return {
      consumer,
      seed: (renderId: string) => consumer.markCreated(renderId),
      markStatus: (renderId, status) => consumer.markStatus(renderId, status),
    };
  },
});

runPendingEventConsumerConformance('SqlitePendingEventConsumer', {
  create: async () => {
    const consumer = new SqlitePendingEventConsumer({ filename: ':memory:' });
    return {
      consumer,
      seed: (renderId: string) => consumer.markCreated(renderId),
      markStatus: (renderId, status) => consumer.markStatus(renderId, status),
    };
  },
});
