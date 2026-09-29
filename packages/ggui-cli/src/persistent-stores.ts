/**
 * Default-on persistent stores under `<persistentDir>/`. Used when the
 * operator hasn't declared `storage.renders` / `storage.vectors` in
 * `ggui.json` AND hasn't passed `--ephemeral`. Closes the GguiSessionStore
 * leg of the rehydrate problem: without this, a restart drops every
 * render row even though the HMAC secret + ShortCodeIndex now persist.
 *
 * Override precedence (caller enforces):
 *   1. Explicit `ggui.json#storage.renders` / `.vectors`   (user wins)
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
  GguiSessionStore,
  GguiSessionStreamBuffer,
  VectorStore,
} from '@ggui-ai/mcp-server-core';
import type { ResolvedStorageStores } from '@ggui-ai/mcp-server';

/** The persistent session store and the live channel's stream buffer, opened together. */
export interface PersistentSessionStores {
  readonly renderStore: GguiSessionStore;
  readonly streamBuffer: GguiSessionStreamBuffer;
}

/**
 * The persistent sessions and, in the same `sessions.sqlite`, the live
 * channel's stream buffer (ggui#1534), so a session that survives a restart
 * also keeps its stream `seq`, its epoch and its retained envelopes, and a
 * reconnect replays what it missed.
 *
 * Both or neither, by construction: an in-memory store with a persistent
 * buffer would keep counters for sessions that no longer exist, and a
 * persistent store with an in-memory buffer is the gap this closes. If the
 * buffer cannot open, the store it opened first is closed and the error
 * propagates.
 */
export async function createPersistentSessionStores(
  persistentDir: string,
): Promise<PersistentSessionStores> {
  mkdirSync(persistentDir, { recursive: true });
  const { SqliteGguiSessionStore, SqliteGguiSessionStreamBuffer } = await import(
    '@ggui-ai/mcp-server-core/sqlite'
  );
  const filename = join(persistentDir, 'sessions.sqlite');
  const renderStore = new SqliteGguiSessionStore({ filename });
  try {
    return { renderStore, streamBuffer: new SqliteGguiSessionStreamBuffer({ filename }) };
  } catch (err) {
    renderStore.close();
    throw err;
  }
}

/**
 * `ggui serve`'s persistent layer for sessions: when nothing resolved a
 * render store (no `ggui.json#storage.renders`), add the persistent session
 * store and its stream buffer, together (ggui#1534). A bundle that already
 * has a render store is returned untouched. Throws when SQLite is
 * unavailable; the caller falls back to the in-memory defaults.
 */
export async function layerPersistentSessionStores(
  storage: ResolvedStorageStores,
  persistentDir: string,
): Promise<ResolvedStorageStores> {
  if (storage.renderStore !== undefined) return storage;
  const { renderStore, streamBuffer } = await createPersistentSessionStores(persistentDir);
  return { ...storage, renderStore, streamBuffer };
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
