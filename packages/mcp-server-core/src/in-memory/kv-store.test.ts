import { kvStoreContract } from '../contract-tests/kv-store.js';
import { InMemoryKeyValueStore } from './kv-store.js';

kvStoreContract('InMemoryKeyValueStore', () => new InMemoryKeyValueStore(), {
  makeWithClock: async () => {
    let now = 1_700_000_000_000;
    const clock = {
      now: () => now,
      tick: (ms: number) => {
        now += ms;
      },
    };
    return { clock, store: new InMemoryKeyValueStore(clock.now) };
  },
});
