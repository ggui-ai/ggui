/**
 * Resolve a persistent `ShortCodeIndex` for `ggui serve`.
 *
 * The OSS default for `shortCodeIndex` is `InMemoryShortCodeIndex` —
 * the mapping lives in process memory and a restart drops every
 * binding, so `/r/<code>` + `/api/bootstrap/<code>` 404 on the cached
 * envelopes claude.ai stored before the restart.
 *
 * When the CLI is running in persistent mode (no `--ephemeral`), this
 * helper constructs a `SqliteShortCodeIndex` against
 * `<persistentDir>/short-codes.sqlite` so the same lookups survive
 * restart. better-sqlite3 is dynamic-imported (same pattern as
 * `@ggui-ai/mcp-server::resolveStorageFromConfig`) so consumers that
 * stay ephemeral don't pay the N-API binding load on boot.
 *
 * Caller composes the path; this module is pure construction over a
 * given dir + better-sqlite3 dynamic-import, so tests can scope to a
 * tmpdir.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ShortCodeIndex } from '@ggui-ai/mcp-server-core';

/**
 * Construct the persistent ShortCodeIndex backed by `<persistentDir>/
 * short-codes.sqlite`. Creates the parent dir if missing (the persistent
 * dir always exists by the time this is called — the secrets helper
 * already mkdir'd it — but mkdir is idempotent and cheap).
 *
 * Throws if `better-sqlite3` can't be loaded (e.g. native binding
 * missing for the current platform). The CLI surfaces this as a fatal
 * boot error so the operator can either install the binding or pass
 * `--ephemeral`.
 */
export async function createPersistentShortCodeIndex(
  persistentDir: string,
): Promise<ShortCodeIndex> {
  mkdirSync(persistentDir, { recursive: true });
  const { SqliteShortCodeIndex } = await import(
    '@ggui-ai/mcp-server-core/sqlite'
  );
  return new SqliteShortCodeIndex({
    filename: join(persistentDir, 'short-codes.sqlite'),
  });
}
