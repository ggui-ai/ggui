/**
 * `SessionStore` conformance runner — Slice 5.1 first cut.
 *
 * Invokes the shared conformance suite against the OSS in-memory
 * implementation. The same suite is the one cloud adapters
 * (`dynamoSessionStore`, `SqliteSessionStore` post-launch) plug into
 * from their own test files, catching drift the moment an
 * implementation regresses on the documented bug classes.
 *
 * Three bug classes pinned (from the Phase 2 cloud retirements):
 *   - endUserIdentity JSON parse (cloud get-stack retire `a351194b7`)
 *   - sessionStatus precedence (cloud get-session retire `c68bacdbb`)
 *   - popStackItem secondary-index cleanup (cloud pop retire `4e2395da0`)
 *
 * See `./session-store.conformance.ts` for the full suite.
 */
import { InMemorySessionStore } from '../in-memory/session-store.js';
import { SqliteSessionStore } from '../sqlite/session-store.js';
import { runSessionStoreConformance } from './session-store.conformance.js';

runSessionStoreConformance('InMemorySessionStore', {
  create: async () => new InMemorySessionStore(),
});

// Each Sqlite invocation gets an in-memory db (`:memory:`) so the
// conformance run is hermetic — no filesystem state leaks between
// tests. The DB lives only for the test's `withStore` scope; the
// suite's per-test `cleanup` hook (here unused — process-exit reclaims
// the in-memory db) keeps the API symmetric with future temp-file
// invocations.
runSessionStoreConformance('SqliteSessionStore', {
  create: async () => new SqliteSessionStore({ filename: ':memory:' }),
});
