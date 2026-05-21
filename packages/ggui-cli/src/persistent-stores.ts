/**
 * Default-on persistent stores under `<persistentDir>/`. Used when the
 * operator hasn't declared `storage.sessions` / `storage.vectors` in
 * `ggui.json` AND hasn't passed `--ephemeral`. Closes the SessionStore
 * leg of the rehydrate problem: without this, a restart drops every
 * session row even though the HMAC secret + ShortCodeIndex now persist.
 *
 * Override precedence (caller enforces):
 *   1. Explicit `ggui.json#storage.sessions` / `.vectors`   (user wins)
 *   2. These defaults                                       (operator-friendly)
 *   3. In-memory (`createGguiServer`'s internal fallback)   (last resort)
 *
 * `better-sqlite3` is dynamic-imported (same pattern as the storage
 * resolver in `@ggui-ai/mcp-server`) so `--ephemeral` runs don't pay
 * the N-API binding load.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SessionStore,
  VectorStore,
} from '@ggui-ai/mcp-server-core';

export async function createPersistentSessionStore(
  persistentDir: string,
): Promise<SessionStore> {
  mkdirSync(persistentDir, { recursive: true });
  const { SqliteSessionStore } = await import(
    '@ggui-ai/mcp-server-core/sqlite'
  );
  return new SqliteSessionStore({
    filename: join(persistentDir, 'sessions.sqlite'),
  });
}

export async function createPersistentVectorStore(
  persistentDir: string,
): Promise<VectorStore> {
  mkdirSync(persistentDir, { recursive: true });
  const { SqliteVectorStore } = await import(
    '@ggui-ai/mcp-server-core/sqlite'
  );
  return new SqliteVectorStore({
    filename: join(persistentDir, 'vectors.sqlite'),
  });
}

/**
 * Compute the auto-default `keysFile` path. Returns `undefined` when
 * the caller wants ephemeral pairing (the operator already passed
 * `--keys-file` explicitly, or `--ephemeral` is on). The CLI uses
 * this to honour explicit operator paths while still providing a
 * survives-restart default in the common case.
 */
export function defaultKeysFile(persistentDir: string): string {
  return join(persistentDir, 'keys.json');
}
