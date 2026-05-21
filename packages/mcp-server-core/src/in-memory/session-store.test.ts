import { sessionStoreContract } from '../contract-tests/session-store.js';
import { InMemorySessionStore } from './session-store.js';

sessionStoreContract('InMemorySessionStore', () => new InMemorySessionStore(), {
  makeWithClock: async () => {
    let now = 1_700_000_000_000;
    const clock = {
      now: () => now,
      tick: (ms: number) => {
        now += ms;
      },
    };
    return { clock, store: new InMemorySessionStore({ now: clock.now }) };
  },
});
