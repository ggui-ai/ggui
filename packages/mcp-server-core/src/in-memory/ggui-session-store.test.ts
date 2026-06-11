/**
 * InMemoryGguiSessionStore tests.
 *
 * Two shared batteries, both from `../contract-tests`:
 *
 *   1. {@link gguiSessionStoreContract} — the normative semantics
 *      suite (create/get/list round-trips, monotonic gap-free seq,
 *      observe snapshot-then-tail, expiry status via injected clock).
 *   2. {@link runGguiSessionStoreConformance} — the bug-class battery
 *      (endUserIdentity round-trip parity, status precedence, commit
 *      upsert-in-place).
 *
 * The in-memory store is the zero-config OSS default; these suites are
 * its direct gate. The sqlite sibling runs the same batteries from
 * `../sqlite/ggui-session-store.test.ts`.
 */
import { gguiSessionStoreContract } from '../contract-tests/ggui-session-store.js';
import { runGguiSessionStoreConformance } from '../contract-tests/ggui-session-store.conformance.js';
import { InMemoryGguiSessionStore } from './ggui-session-store.js';

gguiSessionStoreContract(
  'InMemoryGguiSessionStore',
  () => new InMemoryGguiSessionStore(),
  {
    makeWithClock: async () => {
      let now = 1_700_000_000_000;
      const clock = {
        now: () => now,
        tick: (ms: number) => {
          now += ms;
        },
      };
      return {
        clock,
        store: new InMemoryGguiSessionStore({ now: clock.now }),
      };
    },
  },
);

runGguiSessionStoreConformance('InMemoryGguiSessionStore', {
  create: async () => new InMemoryGguiSessionStore(),
});
