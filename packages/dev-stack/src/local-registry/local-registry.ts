/**
 * `LocalUiRegistry` — the first real implementation of
 * `@ggui-ai/ui-registry`'s `UiRegistry` contract.
 *
 * Scope (compile-on-demand slice, 2026-04-18):
 *
 *   - Read-only. `capabilities.writable === false`;
 *     `capabilities.observable === false`.
 *   - Manifest-backed. Discovery runs against `ggui.json` +
 *     `blueprints.include` globs via `./discovery.js` and is
 *     cached in memory. `refresh()` re-runs discovery on demand;
 *     file watching / `subscribe()` lands with a follow-up
 *     HMR slice.
 *   - `getBundle(id)` resolution order:
 *       1. **Precompiled fast-path** — colocated `ggui.ui.js` or
 *          `ggui.ui.mjs` beside the manifest. Lets a project with
 *          its own build step opt out of compile-on-demand.
 *       2. **Compile-on-demand** — resolve the manifest's
 *          `entryPoint` (or a conventional `.tsx` filename beside
 *          the manifest), run esbuild against it, return the
 *          bundled ESM output. See `./compile-ui.ts`.
 *       3. **Undefined** — the id is known to the registry but we
 *          could find neither a precompiled artifact nor a TSX
 *          entry. Per the `UiRegistry` contract, this is a valid
 *          "no bundle" state, not an error — callers render the
 *          "no preview available" affordance.
 *
 * Consumers that want to distinguish "missing entry" from "compile
 * failed" need the richer {@link LocalBundleSource.fetchBundle}
 * result — `getBundle` collapses both to the contract's
 * `undefined` so the `UiRegistry` seam stays clean. The HTTP layer
 * calls `fetchBundle` directly for actionable 4xx / 422 responses.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  UiBundle,
  UiManifestEntry,
  UiRegistry,
  UiRegistryCapabilities,
} from '@ggui-ai/ui-registry';
import {
  discoverLocalUis,
  type DiscoveredUi,
  type DiscoveryIssue,
  type GguiJsonV1,
} from '@ggui-ai/project-config/node';
import {
  compileUiOnDemand,
  COMPILED_BUNDLE_CONTENT_TYPE,
  resolveEntryFile,
  type CompileResult,
} from './compile-ui.js';
import { createLocalWatcher, type LocalWatcher, type WatchListener } from './watcher.js';

/** Accepted bundle filenames, in preference order. */
const BUNDLE_FILENAMES = ['ggui.ui.js', 'ggui.ui.mjs'] as const;

/** Content-Type we claim for the compiled bundle. */
const BUNDLE_CONTENT_TYPE = 'application/javascript+react';

export interface LocalUiRegistryOptions {
  /** Absolute project root — directory containing `ggui.json`. */
  projectRoot: string;
  /** The parsed `ggui.json`. Only `blueprints.include` is consumed today. */
  manifest: GguiJsonV1;
}

/**
 * Richer bundle result — the HTTP layer branches on this to return
 * the right status code / JSON body. `LocalUiRegistry.getBundle`
 * collapses everything into `UiBundle | undefined` per the
 * `@ggui-ai/ui-registry` contract.
 */
export type LocalBundleResult =
  | { kind: 'ok'; bundle: UiBundle; source: 'precompiled' | 'compiled' }
  | { kind: 'not-found' }
  | { kind: 'missing-entry'; tried: string[] }
  | {
      kind: 'compile-failed';
      entry: string;
      errors: Array<{ text: string; location: BundleErrorLocation | null }>;
      warnings: Array<{ text: string; location: BundleErrorLocation | null }>;
    };

/** Flat, wire-safe subset of esbuild's Location shape. */
export interface BundleErrorLocation {
  file: string;
  line: number;
  column: number;
  length: number;
  lineText: string;
}

export class LocalUiRegistry implements UiRegistry {
  readonly capabilities: UiRegistryCapabilities = {
    writable: false,
    observable: true,
  };

  private readonly projectRoot: string;
  private readonly manifest: GguiJsonV1;
  private entriesById = new Map<string, DiscoveredUi>();
  /** Absolute manifest dir → id. Rebuilt on every refresh so the
   * watcher can attribute source-file changes to the right UI. */
  private manifestDirIndex = new Map<string, string>();
  private lastIssues: DiscoveryIssue[] = [];
  private loaded = false;
  private watcher: LocalWatcher | null = null;

  constructor(options: LocalUiRegistryOptions) {
    this.projectRoot = options.projectRoot;
    this.manifest = options.manifest;
  }

  /**
   * Force a re-scan of the filesystem against `blueprints.include`.
   * Use after edits when `subscribe` isn't wired yet. The HTTP layer
   * can call this on a PUT `/uis/refresh` or similar — not part of
   * this slice.
   */
  async refresh(): Promise<{ uiCount: number; issues: DiscoveryIssue[] }> {
    const result = await discoverLocalUis({
      projectRoot: this.projectRoot,
      manifest: this.manifest,
    });
    const next = new Map<string, DiscoveredUi>();
    const dirIndex = new Map<string, string>();
    for (const ui of result.uis) {
      next.set(ui.id, ui);
      dirIndex.set(dirname(ui.manifestPath), ui.id);
    }
    this.entriesById = next;
    this.manifestDirIndex = dirIndex;
    this.lastIssues = result.issues;
    this.loaded = true;
    return { uiCount: result.uis.length, issues: result.issues };
  }

  /**
   * Subscribe to registry change events. Flips
   * `capabilities.observable` from spec to reality. Starts the
   * underlying filesystem watcher on first call and keeps it
   * alive until all listeners unsubscribe AND {@link close} is
   * invoked (lifetime controlled by the enclosing dev server,
   * not by subscriber churn — SSE clients come and go).
   */
  subscribe(listener: WatchListener): () => void {
    // Ensure the manifest dir index is populated before wiring the
    // watcher — otherwise the first fs events arrive before
    // `refresh()` has ever run and attribute-by-dir lookups return
    // null. `ensureLoaded` is idempotent + cheap.
    void this.ensureLoaded();
    const watcher = this.ensureWatcher();
    return watcher.subscribe(listener);
  }

  /** Shut down the watcher (if any) and drop listeners. */
  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private ensureWatcher(): LocalWatcher {
    if (this.watcher) return this.watcher;
    this.watcher = createLocalWatcher({
      projectRoot: this.projectRoot,
      getManifestDirIndex: () => this.manifestDirIndex,
      onManifestsChanged: async () => {
        await this.refresh();
      },
    });
    return this.watcher;
  }

  /** Diagnostic snapshot — NOT part of the `UiRegistry` surface. */
  getIssues(): readonly DiscoveryIssue[] {
    return this.lastIssues;
  }

  async list(): Promise<UiManifestEntry[]> {
    await this.ensureLoaded();
    return Array.from(this.entriesById.values()).map(toEntry);
  }

  async get(id: string): Promise<UiManifestEntry | undefined> {
    await this.ensureLoaded();
    const ui = this.entriesById.get(id);
    return ui ? toEntry(ui) : undefined;
  }

  async getBundle(id: string): Promise<UiBundle | undefined> {
    const result = await this.fetchBundle(id);
    return result.kind === 'ok' ? result.bundle : undefined;
  }

  /**
   * Richer bundle fetch — exposes the distinct "no colocated
   * artifact AND no TSX entry" vs. "compile failed" states that
   * `getBundle` collapses. The HTTP layer uses this directly so
   * failures become actionable 4xx / 422 responses.
   */
  async fetchBundle(id: string): Promise<LocalBundleResult> {
    await this.ensureLoaded();
    const ui = this.entriesById.get(id);
    if (!ui) return { kind: 'not-found' };

    // Freshness rule (2026-04-18):
    //   precompiled `.js` serves only if it's AT LEAST AS NEW as
    //   the resolved TSX entry. If the TSX is newer — the user just
    //   edited it — we recompile and ignore the stale precompiled
    //   artifact. Stateless, watcher-independent, always correct.
    //
    //   Without this rule a developer's save of ggui.ui.tsx would be
    //   silently masked by an older ggui.ui.js sitting beside it —
    //   exactly the "edit TSX, still serves stale JS" failure mode
    //   the HMR slice must not leave behind.
    const precompiledPath = findColocatedBundlePath(ui.manifestPath);
    const entryResolution = resolveEntryFile({
      projectRoot: this.projectRoot,
      manifestPath: ui.manifestPath,
      manifest: ui.manifest,
    });
    const entryPath = 'entry' in entryResolution ? entryResolution.entry : null;

    if (precompiledPath && shouldPreferPrecompiled(precompiledPath, entryPath)) {
      const code = readFileSync(precompiledPath, 'utf-8');
      return {
        kind: 'ok',
        bundle: { code, contentType: BUNDLE_CONTENT_TYPE },
        source: 'precompiled',
      };
    }

    // Compile-on-demand from the authored TSX entry (or surface
    // missing-entry if neither precompiled nor entry exists).
    const compiled: CompileResult = await compileUiOnDemand({
      projectRoot: this.projectRoot,
      manifestPath: ui.manifestPath,
      manifest: ui.manifest,
    });

    if (compiled.kind === 'ok') {
      return {
        kind: 'ok',
        bundle: { code: compiled.code, contentType: COMPILED_BUNDLE_CONTENT_TYPE },
        source: 'compiled',
      };
    }
    if (compiled.kind === 'missing-entry') {
      return { kind: 'missing-entry', tried: compiled.tried };
    }
    return {
      kind: 'compile-failed',
      entry: compiled.entry,
      errors: compiled.errors.map(toBundleMessage),
      warnings: compiled.warnings.map(toBundleMessage),
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.refresh();
    }
  }
}

function toBundleMessage(
  msg: import('esbuild').Message,
): { text: string; location: BundleErrorLocation | null } {
  const location = msg.location
    ? {
        file: msg.location.file,
        line: msg.location.line,
        column: msg.location.column,
        length: msg.location.length,
        lineText: msg.location.lineText,
      }
    : null;
  return { text: msg.text, location };
}

function toEntry(ui: DiscoveredUi): UiManifestEntry {
  // `manifest.contentHash` is optional per the schema — authored
  // manifests typically omit it until a compile step fills it in.
  // The registry contract requires a non-undefined `contentHash`
  // string; empty signals "no artifact-version pin yet", which is
  // correct for a dev-only source registry.
  return {
    id: ui.id,
    contentHash: ui.manifest.contentHash ?? '',
    manifest: ui.manifest,
  };
}

/**
 * Locate the colocated precompiled bundle next to a manifest,
 * if any. Returns the first matching filename per
 * {@link BUNDLE_FILENAMES} preference or null. Does NOT read the
 * bytes — the freshness comparison runs first, and we only
 * actually read the file when we've decided to serve it.
 */
function findColocatedBundlePath(manifestPath: string): string | null {
  const dir = dirname(manifestPath);
  for (const filename of BUNDLE_FILENAMES) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Mtime-based freshness gate between a precompiled artifact and
 * an authored TSX entry.
 *
 *   - No TSX entry at all → precompiled wins (nothing newer could
 *     replace it; this is the pre-compile-on-demand case).
 *   - TSX exists and is newer than precompiled → recompile. The
 *     developer just edited; serving stale JS is the UX bug this
 *     rule exists to prevent.
 *   - Precompiled newer or equal → precompiled wins (user's own
 *     build step ran; honour it).
 *
 * mtime-compare is stateless, watcher-independent, and correct
 * even when subscribers are not connected.
 */
function shouldPreferPrecompiled(
  precompiledPath: string,
  entryPath: string | null,
): boolean {
  if (!entryPath) return true;
  try {
    const pre = statSync(precompiledPath).mtimeMs;
    const src = statSync(entryPath).mtimeMs;
    return pre >= src;
  } catch {
    // If a stat fails mid-check the safer call is to fall through
    // to recompile — a compile-on-demand with a live entry file
    // always produces fresh output.
    return false;
  }
}
