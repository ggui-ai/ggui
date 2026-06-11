/**
 * Filesystem watcher for the local `ggui dev` registry.
 *
 * Maps raw chokidar events to the contract's `UiRegistryEvent`
 * union (`added` / `changed` / `removed`). The watcher is scoped
 * to what actually affects what a registry consumer can see:
 *
 *   - Any `ggui.ui.json` under the project tree → affects the
 *     manifest itself. A new one means `added`, a deletion
 *     means `removed`, an edit means `changed`.
 *   - Any `.tsx` / `.ts` / `.jsx` / `.js` file in the same
 *     directory as a known manifest (or a descendant of it)
 *     → affects the compiled bundle for that manifest's id.
 *     Emitted as `changed { id }`.
 *   - Any colocated `ggui.ui.js` / `ggui.ui.mjs` change →
 *     also `changed { id }` (the user's own build step ran).
 *
 * Scope deliberately narrow: we don't try to resolve cross-dir
 * imports. A shared utility in `packages/shared/` won't trigger
 * a refresh. That's a known limitation — re-importing the module
 * graph from esbuild metafiles is a bigger slice. For the dev
 * loop, edit the UI file, get the update. Shared-utility edits
 * still work on the next manual reload.
 */
import { stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import type { UiRegistryEvent } from '@ggui-ai/ui-registry';

/**
 * Listener for raw events the watcher emits. Delivery is
 * at-least-once — consumers dedupe where needed (e.g. the SSE
 * handler just forwards; a subscribing UI bumps a counter and
 * doesn't care about dupes).
 */
export type WatchListener = (event: UiRegistryEvent) => void;

export interface LocalWatcherOptions {
  /** Absolute project root — chokidar's root path. */
  projectRoot: string;
  /**
   * Mapping from absolute manifest directory → current UI id.
   * The watcher looks changed files up by walking up directories
   * until it hits one of these paths.
   */
  getManifestDirIndex: () => Map<string, string>;
  /**
   * Called when a `ggui.ui.json` is added or removed so the
   * registry can re-run discovery. Any id/dir index
   * changes it produces propagate on the next fs event.
   */
  onManifestsChanged: () => Promise<void>;
}

export interface LocalWatcher {
  /** Register a listener. Returns an unsubscribe function. */
  subscribe(listener: WatchListener): () => void;
  /** Start watching if not already. Safe to call repeatedly. */
  start(): Promise<void>;
  /** Stop the watcher and drop listeners. */
  close(): Promise<void>;
}

/** Paths that should never trigger discovery / recompile work. */
const IGNORED_SEGMENTS = ['node_modules', '.git', 'dist', '.turbo', '.next', '.ggui-cache'];

/** Filename suffixes we care about for compile invalidation. */
const SOURCE_SUFFIXES = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.css'];

const MANIFEST_FILENAME = 'ggui.ui.json';

export function createLocalWatcher(options: LocalWatcherOptions): LocalWatcher {
  const listeners = new Set<WatchListener>();
  let watcher: FSWatcher | null = null;
  let started = false;

  function emit(event: UiRegistryEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A bad listener mustn't starve other listeners / the
        // watcher itself. Errors surface in caller's own scope.
      }
    }
  }

  /**
   * Resolve the UI id a changed filesystem path belongs to by
   * walking up directories until a known manifest dir matches.
   * Returns `null` when the path lies outside all watched UIs.
   */
  function findOwningId(absolutePath: string): string | null {
    const index = options.getManifestDirIndex();
    let dir = dirname(absolutePath);
    const root = options.projectRoot;
    // Prevent walking past project root — files above it can
    // never belong to a project UI.
    const normalizedRoot = resolve(root);
    while (dir.length >= normalizedRoot.length) {
      const id = index.get(dir);
      if (id !== undefined) return id;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  function isInteresting(absolutePath: string): boolean {
    const rel = relative(options.projectRoot, absolutePath);
    if (rel.startsWith('..')) return false;
    if (rel.split(sep).some((seg) => IGNORED_SEGMENTS.includes(seg))) return false;
    if (absolutePath.endsWith(sep + MANIFEST_FILENAME) || absolutePath.endsWith('/' + MANIFEST_FILENAME)) {
      return true;
    }
    return SOURCE_SUFFIXES.some((suf) => absolutePath.endsWith(suf));
  }

  async function handleFsEvent(
    kind: 'add' | 'change' | 'unlink',
    absolutePath: string,
  ): Promise<void> {
    if (!isInteresting(absolutePath)) return;

    const isManifest =
      absolutePath.endsWith(sep + MANIFEST_FILENAME) ||
      absolutePath.endsWith('/' + MANIFEST_FILENAME);

    if (isManifest) {
      // Let the registry re-scan, then decide what to emit from
      // the updated index.
      const before = new Set(options.getManifestDirIndex().values());
      await options.onManifestsChanged();
      const after = options.getManifestDirIndex();

      const manifestDir = dirname(absolutePath);
      const idForDir = after.get(manifestDir);

      if (kind === 'unlink') {
        // The manifest went away — find any id that was present
        // before but isn't now and emit removed for each.
        for (const id of before) {
          if (!Array.from(after.values()).includes(id)) {
            emit({ type: 'removed', id });
          }
        }
        return;
      }

      if (idForDir === undefined) {
        // Manifest add/change that didn't produce a valid id
        // (e.g., parse failure, duplicate-id conflict). Issues
        // are collected by the registry; no event to emit.
        return;
      }

      if (!before.has(idForDir)) {
        emit({ type: 'added', id: idForDir });
      } else {
        emit({ type: 'changed', id: idForDir, contentHash: '' });
      }
      return;
    }

    // Non-manifest source file. Attribute it to the nearest
    // manifest directory above.
    const owningId = findOwningId(absolutePath);
    if (owningId === null) return;
    emit({ type: 'changed', id: owningId, contentHash: '' });
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;

    // chokidar v4 uses a path-match function for ignored. We
    // filter in `handleFsEvent` too, but keeping the ignored
    // list on the watcher avoids waking up for every stat on
    // massive vendored trees.
    watcher = chokidarWatch(options.projectRoot, {
      ignored: (path: string) => {
        const rel = relative(options.projectRoot, path);
        if (rel === '' || rel === '.') return false;
        return rel.split(sep).some((seg) => IGNORED_SEGMENTS.includes(seg));
      },
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    watcher.on('add', (p) => {
      void handleFsEvent('add', p);
    });
    watcher.on('change', (p) => {
      void handleFsEvent('change', p);
    });
    watcher.on('unlink', (p) => {
      void handleFsEvent('unlink', p);
    });
    // Directory-level deletes bubble up through `unlink` for
    // contained files; no special `unlinkDir` handling needed.

    // Give chokidar a microtask to initialise before we return
    // — many platforms emit a `ready` event, but awaiting that
    // is implementation-specific. The watcher works synchronously
    // enough that callers who depend on first-event ordering
    // should use `awaitReady()` below.
    await new Promise<void>((ready) => {
      const w = watcher;
      if (!w) return ready();
      w.once('ready', () => ready());
      // Safety timeout — extremely-slow fs init shouldn't block
      // a CLI invocation forever.
      setTimeout(ready, 500).unref?.();
    });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      // Lazy-start on first subscribe keeps cost zero when
      // nobody's watching.
      void start();
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    async close() {
      listeners.clear();
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      started = false;
    },
  };
}

/**
 * Utility used by tests and the registry — `fs.stat` with a
 * `null` on missing-file so callers can compare mtimes without
 * branching on ENOENT.
 */
export async function statOrNull(
  path: string,
): Promise<{ mtimeMs: number } | null> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}
