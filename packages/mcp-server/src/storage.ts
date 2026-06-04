/**
 * Storage config → concrete adapter resolver.
 *
 * Bridges `@ggui-ai/project-config`'s declarative `ggui.json#storage`
 * block to the concrete `@ggui-ai/mcp-server-core` adapters. Thin and
 * boring by design: one config → one set of instances.
 *
 * ## Why this lives in @ggui-ai/mcp-server (not core, not project-config)
 *
 *   - `@ggui-ai/project-config` is browser-safe + purely declarative.
 *     It must not import `better-sqlite3` (which is a Node addon) or
 *     any concrete adapter — that would poison the import graph for
 *     paste-a-manifest validators, dev UIs, the Studio dashboard.
 *
 *   - `@ggui-ai/mcp-server-core` is the interfaces + reference adapters
 *     layer. It exposes the adapters on subpath exports
 *     (`/sqlite`, `/in-memory`, …) but intentionally doesn't know about
 *     `ggui.json` — keeping the interface layer free of file-format
 *     coupling lets non-OSS consumers (hosted closed runtimes, future
 *     private adapters) bind the same interfaces without dragging the
 *     OSS manifest schema through their code.
 *
 *   - `@ggui-ai/mcp-server` is the OSS runtime that actually reads
 *     `ggui.json` and serves requests. That's where the bridge
 *     belongs — one hop away from the actual `ggui serve` caller.
 *
 * ## Why `better-sqlite3` gets imported dynamically
 *
 * `better-sqlite3` is an optional peer dep of `@ggui-ai/mcp-server-core`.
 * If we `import { SqliteRenderStore } from '@ggui-ai/mcp-server-core/sqlite'`
 * at the top of this file, any consumer that doesn't opt into SQLite
 * storage still pays the peer-dep cost (the module graph resolves the
 * subpath at import time, which tries to load better-sqlite3's N-API
 * binary). Dynamic `await import(...)` keeps the cost truly optional:
 * SQLite is loaded only when `storage.renders.driver === 'sqlite'` or
 * `storage.vectors.driver === 'sqlite'`.
 *
 * ## Why this is async + returns a bundle instead of augmenting createGguiServer
 *
 * `createGguiServer` stays synchronous — no public API break. Callers
 * who want storage from config write:
 *
 * ```ts
 * const { renderStore, vectors } =
 *   await resolveStorageFromConfig(manifest.storage, { baseDir: projectRoot });
 * const server = createGguiServer({ renderStore, vectors });
 * ```
 *
 * Explicit instances passed to `createGguiServer` still win — this
 * resolver is a convenience for the ggui.json path, not a requirement.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  RenderStore,
  ThreadStore,
  VectorStore,
} from '@ggui-ai/mcp-server-core';
// `InMemoryThreadStore` is a static import — unlike the sqlite
// adapters, the in-memory subpath carries no optional peer dep cost
// (no `better-sqlite3`, no N-API binding). `storage.threads.driver =
// 'memory'` uses this to mount actual thread routes instead of being
// a silent no-op like renders/vectors (which createGguiServer
// already defaults to in-memory internally).
import { InMemoryThreadStore } from '@ggui-ai/mcp-server-core/in-memory';
import type { StorageConfig } from '@ggui-ai/project-config';

export interface ResolveStorageFromConfigOptions {
  /**
   * Directory used to resolve relative `path` values in the storage
   * config. Typically the directory containing `ggui.json` so a
   * manifest saying `"path": "./ggui-renders.sqlite"` lands next to
   * the manifest (not CWD, which would silently create a file wherever
   * the process happened to be started).
   *
   * Absolute paths in the config are honored verbatim. Omitting
   * `baseDir` means relative paths resolve against `process.cwd()` —
   * fine for ad-hoc programmatic callers, but `ggui serve` always
   * passes the project root so the behavior is deterministic.
   */
  readonly baseDir?: string;
}

export interface ResolvedStorageStores {
  /** Concrete RenderStore, iff the config declared one. Undefined =
   * caller falls back to createGguiServer's in-memory default. */
  readonly renderStore?: RenderStore;
  /** Concrete VectorStore, iff the config declared one. Undefined =
   * caller falls back to createGguiServer's in-memory default. */
  readonly vectors?: VectorStore;
  /** Concrete ThreadStore, iff the config declared one. Undefined
   * ONLY when `storage.threads` is absent from the manifest — in
   * that case the caller skips the `threads:` opt-in on
   * `createGguiServer` and no thread routes mount at all.
   *
   * When the manifest declares `storage.threads`, a store is
   * ALWAYS returned:
   *   - `driver: 'memory'` → `InMemoryThreadStore` (ephemeral but
   *     real; routes mount and work until restart).
   *   - `driver: 'sqlite'` → `SqliteThreadStore` (durable).
   *
   * This is the one semantic deviation from renders/vectors, which
   * treat `driver: 'memory'` as a no-op because `createGguiServer`
   * already defaults those to in-memory stores internally. Threads
   * don't have an implicit default — the whole route family is
   * opt-in — so `'memory'` has to resolve to a real store or be
   * rejected at schema time. Resolving to `InMemoryThreadStore` is
   * the less-surprising of the two. */
  readonly threadStore?: ThreadStore;
  /**
   * Durability claim for the resolved thread store. Present iff
   * `threadStore` is present. `'durable'` for sqlite; `'ephemeral'`
   * for memory. Callers pass this straight through to
   * `createGguiServer({ threads: { durability } })` so the server's
   * `/ggui/health` advertisement matches the active store.
   */
  readonly threadDurability?: 'durable' | 'ephemeral';
}

/**
 * Instantiate the concrete storage adapters declared in a parsed
 * `ggui.json#storage` block.
 *
 *   - Absent config                    → `{}` (every surface
 *                                         falls back to createGguiServer's
 *                                         in-memory defaults, or in the
 *                                         case of `threads:`, no thread
 *                                         routes at all).
 *
 *   - `renders` / `vectors`:
 *       - `driver: 'memory'`            → omitted from the bundle
 *                                         (same fallback — declaring
 *                                         memory is the same outcome
 *                                         as omitting it; present
 *                                         for intent visibility).
 *       - `driver: 'sqlite'`            → `SqliteRenderStore` /
 *                                         `SqliteVectorStore`.
 *
 *   - `threads`:
 *       - `driver: 'memory'`            → `InMemoryThreadStore` +
 *                                         `threadDurability: 'ephemeral'`.
 *                                         Routes mount; data lost on
 *                                         restart. Declaring this is
 *                                         how an operator asks for
 *                                         ephemeral threads.
 *       - `driver: 'sqlite'`            → `SqliteThreadStore` +
 *                                         `threadDurability: 'durable'`.
 *
 * Dynamic import of `@ggui-ai/mcp-server-core/sqlite` means
 * `better-sqlite3` is only required when the config actually declares
 * sqlite somewhere. Memory-only configs don't touch the optional peer
 * dep — `InMemoryThreadStore` is a static import because the in-memory
 * subpath has no peer dep cost.
 */
export async function resolveStorageFromConfig(
  config: StorageConfig | undefined,
  opts: ResolveStorageFromConfigOptions = {},
): Promise<ResolvedStorageStores> {
  if (!config) return {};

  const rendersSqlite = config.renders?.driver === 'sqlite';
  const vectorsSqlite = config.vectors?.driver === 'sqlite';
  const threadsSqlite = config.threads?.driver === 'sqlite';
  const threadsMemory = config.threads?.driver === 'memory';

  const result: {
    renderStore?: RenderStore;
    vectors?: VectorStore;
    threadStore?: ThreadStore;
    threadDurability?: 'durable' | 'ephemeral';
  } = {};

  // Handle the memory-threads branch BEFORE the sqlite dynamic import
  // gate so `driver: 'memory'`-only configs don't pull in
  // better-sqlite3 at all.
  if (threadsMemory) {
    result.threadStore = new InMemoryThreadStore();
    result.threadDurability = 'ephemeral';
  }

  if (!rendersSqlite && !vectorsSqlite && !threadsSqlite) return result;

  // Single dynamic import serves every sqlite adapter — better-sqlite3's
  // N-API binding loads once even if the import lands twice; the
  // subpath barrel is cached by Node's module loader.
  const { SqliteRenderStore, SqliteVectorStore, SqliteThreadStore } =
    await import('@ggui-ai/mcp-server-core/sqlite');

  if (config.renders && config.renders.driver === 'sqlite') {
    const filename = resolveStoragePath(config.renders.path, opts.baseDir);
    ensureParentDir(filename);
    result.renderStore = new SqliteRenderStore({ filename });
  }
  if (config.vectors && config.vectors.driver === 'sqlite') {
    const filename = resolveStoragePath(config.vectors.path, opts.baseDir);
    ensureParentDir(filename);
    result.vectors = new SqliteVectorStore({ filename });
  }
  if (config.threads && config.threads.driver === 'sqlite') {
    const filename = resolveStoragePath(config.threads.path, opts.baseDir);
    ensureParentDir(filename);
    result.threadStore = new SqliteThreadStore({ filename });
    result.threadDurability = 'durable';
  }
  return result;
}

/**
 * Create the parent directory of a sqlite database file if it doesn't
 * already exist. Turns the declarative `path: './data/renders.sqlite'`
 * into a working adapter without forcing the operator to mkdir by hand
 * — better-sqlite3 refuses to open a file whose parent doesn't exist,
 * and the parent is uninteresting bookkeeping the manifest already
 * implies.
 *
 * Not "silent file creation" — the operator declared the path in
 * `ggui.json`; honoring it is the whole point of opt-in. No-op for
 * `:memory:` and for paths whose parent already exists.
 */
function ensureParentDir(resolvedPath: string): void {
  if (resolvedPath === ':memory:') return;
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
}

/**
 * Resolve a storage `path` from the manifest. Absolute paths pass
 * through; relative paths resolve against `baseDir` (typically the
 * ggui.json directory). `baseDir` absent falls back to `process.cwd()`
 * so ad-hoc programmatic callers still work.
 *
 * `:memory:` is intentionally NOT special-cased here — callers who
 * want an in-memory database should declare `driver: 'memory'` in the
 * manifest. An explicit `:memory:` as a sqlite path is honored (passes
 * straight through to better-sqlite3), but it's a power-user escape
 * hatch, not the documented path.
 */
function resolveStoragePath(rawPath: string, baseDir?: string): string {
  if (rawPath === ':memory:') return rawPath;
  if (path.isAbsolute(rawPath)) return rawPath;
  const root = baseDir ?? process.cwd();
  return path.resolve(root, rawPath);
}
