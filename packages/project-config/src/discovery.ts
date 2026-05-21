/**
 * Blueprint manifest discovery — turns a loaded `ggui.json` into the
 * set of authored UIs the project declares via `blueprints.include`.
 *
 * The flow:
 *
 *   ggui.json.blueprints.include (globs, relative to project root)
 *     → filesystem match (tinyglobby)
 *     → load each `ggui.ui.json`
 *     → parse via {@link parseUiManifest}
 *     → return `{ id, manifestPath, manifest }` tuples
 *
 * Per the registry-source architecture lock (plan §8.6), every UI
 * carries a stable machine-oriented `id` that survives renames and
 * content edits. Duplicate ids across manifests are a load-bearing
 * error — two sources cannot share identity — so we surface them as
 * structured issues rather than silently last-writer-wins.
 *
 * ## Error model
 *
 * Discovery never throws on a per-manifest failure. One malformed
 * `ggui.ui.json` should not black-hole the rest of the project — the
 * `ggui dev` hub renders the valid UIs + flags the bad ones in the
 * UI. Each issue carries a path + message so callers can render a
 * useful list.
 *
 * Callers that need fail-fast semantics (e.g. `ggui serve` boot, where
 * continuing with a partial set is a silent deploy-time regression)
 * inspect `result.issues` themselves and escalate to a thrown error
 * when non-empty. This helper stays policy-neutral.
 *
 * ## Why `@ggui-ai/project-config/node`, not a sibling package
 *
 * Discovery is filesystem + parse + identity check. It is NOT HTTP,
 * agent runtime, or registry state. Two consumers need it today:
 *
 *   - `@ggui-ai/dev-stack`'s `LocalUiRegistry`, which powers the
 *     `ggui dev` hub's compile-on-demand view.
 *   - `@ggui-ai/mcp-server` at `ggui serve` boot time — so the OSS
 *     MCP server's blueprint-read handlers actually consume the
 *     declared capability surface instead of returning the empty
 *     pre-manifest placeholder.
 *
 * Housing it in `@ggui-ai/project-config/node` (the schema-owner's
 * Node subpath) keeps one source of truth and avoids a dev-stack →
 * mcp-server import edge (dev-stack pulls HTTP / Vite / SSE runtime
 * infrastructure that has no business booting inside a pure MCP
 * server).
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { glob } from 'tinyglobby';
import type { GguiJsonV1 } from './schema.js';
import {
  GGUI_UI_JSON_FILENAME,
  parseUiManifest,
  type UiManifest,
} from './ui-manifest.js';

/**
 * One discovered UI — the stable id + absolute manifest path + the
 * parsed manifest shape. Callers address by id; the paths are for
 * compile lookups and for informational output.
 */
export interface DiscoveredUi {
  id: string;
  manifestPath: string;
  manifest: UiManifest;
}

/**
 * An error surfaced during discovery. Discovery never throws on a
 * single bad manifest — one malformed UI shouldn't black-hole the
 * rest of the project. Instead we collect issues with per-file
 * provenance so the CLI can render them and continue serving the
 * valid ones.
 */
export interface DiscoveryIssue {
  /**
   * Path of the offending manifest, relative to the project root if
   * it was reachable, absolute if the failure happened before we
   * could compute a sensible relative path.
   */
  path: string;
  message: string;
  /** Underlying cause (typically a `ZodError` or `SyntaxError`). */
  cause?: unknown;
}

/** Result of a full discovery pass. */
export interface DiscoveryResult {
  /** Successfully parsed UIs, in filesystem-walk order. */
  uis: DiscoveredUi[];
  /** Issues that should be rendered to the user; discovery still returns. */
  issues: DiscoveryIssue[];
}

export interface DiscoverOptions {
  /**
   * Absolute project root — the directory containing `ggui.json`.
   * Globs in `blueprints.include` are resolved relative to this
   * directory.
   */
  projectRoot: string;
  /** The parsed `ggui.json`. Only `blueprints.include` is consumed today. */
  manifest: GguiJsonV1;
}

/**
 * Walk `blueprints.include`, load every matched `ggui.ui.json`, and
 * return discovered UIs plus accumulated issues.
 *
 * Ordering: filesystem-walk order from `tinyglobby` (currently
 * alphabetical within each match). Callers that care about stable
 * ordering across file renames should sort by `id` or `manifest.name`
 * themselves.
 *
 * Duplicate-id handling: the first encounter wins and the rest are
 * surfaced as {@link DiscoveryIssue} entries. Two sources with the
 * same id would violate the registry-source identity invariant — we
 * would rather emit a noisy conflict than silently overwrite.
 *
 * Glob mismatch handling: a glob pattern that matches a file whose
 * basename isn't `ggui.ui.json` is ignored (not an error) — users
 * sometimes cast wide `**` patterns intentionally. A glob that
 * matches nothing at all is allowed; the manifest may exist in
 * anticipation of UIs not authored yet.
 */
export async function discoverLocalUis(
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  const { projectRoot, manifest } = options;

  if (!isAbsolute(projectRoot)) {
    throw new Error(
      `discoverLocalUis: projectRoot must be absolute, got ${projectRoot}`,
    );
  }

  const patterns = manifest.blueprints.include;
  const uis: DiscoveredUi[] = [];
  const issues: DiscoveryIssue[] = [];
  const seenIds = new Map<string, string>(); // id → manifestPath

  if (patterns.length === 0) {
    return { uis, issues };
  }

  const matches = await glob(patterns, {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    // Symlink-following off by default — matches the usual "source
    // is in the repo" expectation and keeps discovery cheap.
    followSymbolicLinks: false,
    // No dot-file expansion unless the user explicitly opted in via
    // a pattern starting with `.`; stays consistent with most git /
    // tooling defaults.
    dot: false,
  });

  for (const absolutePath of matches) {
    const relPath = relative(projectRoot, absolutePath);
    const displayPath = relPath === '' ? absolutePath : relPath;

    // Skip files whose basename doesn't look like a per-UI manifest.
    // `blueprints.include` is intentionally glob-based; users
    // sometimes write `ui/**/*.json` and pick up README JSONs etc.
    if (!absolutePath.endsWith(`/${GGUI_UI_JSON_FILENAME}`)) {
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(absolutePath, 'utf-8');
    } catch (cause) {
      issues.push({
        path: displayPath,
        message: `Could not read ${GGUI_UI_JSON_FILENAME}: ${errorMessage(cause)}`,
        cause,
      });
      continue;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (cause) {
      issues.push({
        path: displayPath,
        message: `${GGUI_UI_JSON_FILENAME} is not valid JSON: ${errorMessage(cause)}`,
        cause,
      });
      continue;
    }

    let parsed: UiManifest;
    try {
      parsed = parseUiManifest(decoded);
    } catch (cause) {
      issues.push({
        path: displayPath,
        message: `${GGUI_UI_JSON_FILENAME} failed schema validation: ${errorMessage(cause)}`,
        cause,
      });
      continue;
    }

    const prior = seenIds.get(parsed.id);
    if (prior !== undefined) {
      issues.push({
        path: displayPath,
        message:
          `Duplicate id "${parsed.id}" — already declared by ${prior}. ` +
          `Every ggui.ui.json#id must be unique across the project (registry-source identity).`,
      });
      continue;
    }

    seenIds.set(parsed.id, displayPath);
    uis.push({ id: parsed.id, manifestPath: absolutePath, manifest: parsed });
  }

  return { uis, issues };
}

/**
 * Convenience wrapper for the common "I have a `ggui.json` path, give
 * me the UIs" flow. Resolves the project root from the manifest path.
 */
export async function discoverFromGguiJsonPath(
  manifestPath: string,
  manifest: GguiJsonV1,
): Promise<DiscoveryResult> {
  const projectRoot = dirname(resolve(manifestPath));
  return discoverLocalUis({ projectRoot, manifest });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
