import { describe, expect, it } from 'vitest';
import { streamFanoutContract } from '../contract-tests/stream-fanout.js';
import { InProcessStreamFanout } from './stream-fanout.js';

streamFanoutContract(
  'InProcessStreamFanout',
  () => new InProcessStreamFanout(),
);

describe('InProcessStreamFanout — impl-specific', () => {
  it('subscriberCount reflects eager-register / return lifecycle', async () => {
    const fanout = new InProcessStreamFanout();
    expect(fanout.subscriberCount('s1')).toBe(0);

    const iterable = fanout.subscribe('s1');
    // Eager registration — subscribe() returns WITH the subscriber
    // already in the session's live set. This is what makes
    // "publish-after-subscribe-returns is delivered" keepable.
    expect(fanout.subscriberCount('s1')).toBe(1);

    const iter = iterable[Symbol.asyncIterator]();
    await iter.return?.();
    expect(fanout.subscriberCount('s1')).toBe(0);
  });

  it('close(renderId) clears subscriberCount and drains parked waiters', async () => {
    const fanout = new InProcessStreamFanout();
    const iter1 = fanout.subscribe('s1')[Symbol.asyncIterator]();
    const iter2 = fanout.subscribe('s1')[Symbol.asyncIterator]();
    expect(fanout.subscriberCount('s1')).toBe(2);

    // Park both iterators on next(); no publishes incoming.
    const p1 = iter1.next();
    const p2 = iter2.next();

    await fanout.close('s1');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.done).toBe(true);
    expect(r2.done).toBe(true);
    expect(fanout.subscriberCount('s1')).toBe(0);
  });

  it('publishes queue when no waiter is parked', async () => {
    const fanout = new InProcessStreamFanout();
    const iter = fanout.subscribe('s1')[Symbol.asyncIterator]();

    // Publish 3 without calling next() — frames queue up on the
    // subscriber. Then drain.
    for (let i = 1; i <= 3; i++) {
      await fanout.publish({
        renderId: 's1',
        envelope: {
          renderId: 's1',
          seq: i,
          channel: 'message',
          mode: 'append',
          payload: {},
        },
      });
    }
    const a = await iter.next();
    const b = await iter.next();
    const c = await iter.next();
    expect([a.value?.seq, b.value?.seq, c.value?.seq]).toEqual([1, 2, 3]);
    await fanout.close('s1');
  });
});
