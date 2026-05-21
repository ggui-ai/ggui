/**
 * `ggui serve` agent-plan resolver — the §10.2a fallback matrix.
 *
 * Reads `ggui.json` via `@ggui-ai/project-config/node`, resolves the
 * `agent.entry` (if any) via `./agent-resolution.ts`, and returns a
 * `ResolvedAgentPlan` that the CLI runner hands straight to
 * `runServe`. Pure-ish — does real file I/O so tests exercise it
 * with `mkdtempSync` + `writeFileSync` rather than mocking.
 *
 * Split out from `cli.ts` so the bin's top-level `main()` call
 * doesn't fire when the test runner imports this module.
 */
import { dirname } from 'node:path';
import {
  findGguiJson,
  GguiJsonLoadError,
  safeLoadGguiJson,
  type GguiJsonV1,
} from '@ggui-ai/project-config/node';
import {
  buildAgentRuntime,
  resolveAgentCommand,
} from './agent-resolution.js';
import type {
  AgentStatus,
  ServeAgentSupervision,
} from './serve-command.js';

/**
 * Resolved state of the agent component at `ggui serve` boot time.
 *
 * - `status.kind === 'running'` → `supervision` populated; the
 *   runner supervises the agent.
 * - `status.kind === 'disabled'` → `supervision` absent; the
 *   runner boots MCP-only with the banner surfacing the reason.
 *
 * `warnings` carries non-fatal messages the CLI prints BEFORE the
 * banner (stderr). Hard errors (malformed ggui.json, bad entry
 * extension) are thrown and caught by the CLI wrapper (exit 1).
 */
export interface ResolvedAgentPlan {
  readonly status: AgentStatus;
  readonly supervision?: ServeAgentSupervision;
  readonly warnings: readonly string[];
  /**
   * Fully-parsed `ggui.json` when one was found (regardless of whether
   * `agent.entry` is present). `null` when no manifest was found on the
   * ancestor walk. CLI callers use this to resolve the storage block
   * into concrete adapters via `resolveStorageFromConfig`.
   */
  readonly manifest: GguiJsonV1 | null;
  /**
   * Absolute path to the manifest's parent directory — the canonical
   * root for resolving relative paths declared in the manifest
   * (`storage.sessions.path`, `agent.entry`, future additive fields).
   * `null` when no manifest was found.
   */
  readonly projectRoot: string | null;
}

export interface ResolveAgentPlanOptions {
  /** `true` = operator opted out of agent supervision. */
  readonly mcpOnly: boolean;
  /** Starting directory for the ancestor walk to `ggui.json`. */
  readonly cwd: string;
  /**
   * Event sink for the agent supervision. Tests pass a collector;
   * production passes a function that writes `[agent …]` lines
   * to `process.stderr`. Absent = silent.
   */
  readonly onAgentEvent?: ServeAgentSupervision['onEvent'];
}

/**
 * Apply the §10.2a matrix. Throws `GguiJsonLoadError` for cases 3
 * (malformed JSON, schema failure) and a generic `Error` for case
 * 4 (unsupported agent.entry extension / missing file hint).
 *
 * Returns a `ResolvedAgentPlan` for cases 1, 2, 5, and 6:
 *
 *   1. `--mcp-only`                          → disabled, silent
 *   2. no ggui.json found                    → disabled, warn
 *   5. ggui.json present, no agent.entry     → disabled, warn
 *   6. valid agent.entry                     → running, no warn
 */
export function resolveAgentPlan(
  opts: ResolveAgentPlanOptions,
): ResolvedAgentPlan {
  // `--mcp-only` short-circuits agent supervision but still loads the
  // manifest so the caller sees the storage block (and the project
  // root, used to resolve relative storage paths against the manifest
  // dir rather than CWD). Malformed manifest still escalates.
  if (opts.mcpOnly) {
    const { manifest, projectRoot } = tryLoadManifest(opts.cwd);
    return {
      status: { kind: 'disabled', reason: '--mcp-only' },
      warnings: [],
      manifest,
      projectRoot,
    };
  }

  const manifestPath = findGguiJson(opts.cwd);
  if (!manifestPath) {
    return {
      status: { kind: 'disabled', reason: 'no ggui.json' },
      warnings: [
        'no ggui.json found — running MCP-only. ' +
          'create ggui.json with agent.entry to run your agent alongside.',
      ],
      manifest: null,
      projectRoot: null,
    };
  }

  const loaded = safeLoadGguiJson(manifestPath);
  if (!loaded.success) {
    throw loaded.error;
  }

  const manifest: GguiJsonV1 = loaded.data;
  const projectRoot = dirname(manifestPath);

  if (!manifest.agent?.entry) {
    return {
      status: { kind: 'disabled', reason: 'ggui.json has no agent.entry' },
      warnings: [
        `${manifestPath} found but agent.entry is not set — running MCP-only. ` +
          'add agent.entry to run your agent.',
      ],
      manifest,
      projectRoot,
    };
  }

  const resolution = resolveAgentCommand(manifest.agent.entry, projectRoot);
  if (!resolution.ok) {
    throw new Error(`ggui.json agent.entry: ${resolution.error}`);
  }

  const adapter = buildAgentRuntime(resolution);
  const supervision: ServeAgentSupervision = {
    adapter,
    startInput: {
      projectRoot,
      project: {
        slug: manifest.app.slug,
        name: manifest.app.name,
        protocol: manifest.protocol,
      },
      entry: resolution.entry,
    },
    ...(opts.onAgentEvent ? { onEvent: opts.onAgentEvent } : {}),
  };

  return {
    status: {
      kind: 'running',
      entry: manifest.agent.entry,
      language: resolution.language,
    },
    supervision,
    warnings: [],
    manifest,
    projectRoot,
  };
}

/**
 * Best-effort manifest load for the `--mcp-only` path. Returns
 * `{manifest: null, projectRoot: null}` when no manifest is on disk
 * (MCP-only runs fine without a manifest, so we don't warn here).
 * Malformed / schema-invalid manifests still throw to the CLI
 * wrapper — operators running `--mcp-only` with a broken file want
 * to know.
 */
function tryLoadManifest(cwd: string): {
  manifest: GguiJsonV1 | null;
  projectRoot: string | null;
} {
  const manifestPath = findGguiJson(cwd);
  if (!manifestPath) return { manifest: null, projectRoot: null };
  const loaded = safeLoadGguiJson(manifestPath);
  if (!loaded.success) throw loaded.error;
  return { manifest: loaded.data, projectRoot: dirname(manifestPath) };
}

/**
 * Re-export for tests that want to assert on malformed-config
 * handling without importing project-config transitively.
 */
export { GguiJsonLoadError };
