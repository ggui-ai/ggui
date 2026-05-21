/**
 * MCP mount discovery — turns a loaded `ggui.json#mcpMounts` list into
 * a resolved, imported, factory-invoked set of mount payloads the
 * OSS `ggui serve` path threads into
 * `createGguiServer({ mcpMounts: ... })`.
 *
 * The flow per spec:
 *
 *   string (spec)
 *     → resolve to absolute file path (relative → project root;
 *       bare → Node module resolver)
 *     → dynamic-import
 *     → pick `createGguiMcpMount` or default export
 *     → invoke (zero-arg; awaits Promise)
 *     → structural validate `{ name: string; handlers: array }`
 *
 * This module is **type-thin**: it does NOT import `McpServerMount`
 * from `@ggui-ai/mcp-server`, keeping `@ggui-ai/project-config`'s dep
 * graph honest (no reverse dep from config → server). The CLI
 * (`@ggui-ai/cli`), which already pulls `@ggui-ai/mcp-server`,
 * narrows the returned `handlers: unknown[]` to the concrete
 * `SharedHandler[]` at the adapter boundary. Down-layer collision
 * checks + per-handler validation happen inside
 * `composeHandlersWithMounts` when `createGguiServer` runs.
 *
 * ## Error model
 *
 * Non-throwing per source — one malformed mount does not black-hole
 * the rest of the list. Every failure mode surfaces as an entry in
 * `issues`, with the declared spec on `.path` so renderers can group
 * issues by source. Callers that need fail-fast (`ggui serve` boot)
 * inspect `result.issues` themselves and escalate to a fatal exit.
 * Mirrors the blueprint / primitive discovery split.
 *
 * ## Factory contract lock
 *
 * The resolved module must export either:
 *
 *   - a named `createGguiMcpMount` function, OR
 *   - a default export that is a function.
 *
 * Named export wins if both are present. The function receives zero
 * arguments today; passing options is a future additive (widening the
 * `ggui.json#mcpMounts` entry from `string` to `string | { module,
 * options? }` and threading `options` through here).
 *
 * Mount factories are responsible for their own backing state —
 * instantiating stores, seeding fixtures, wiring adapters — so the
 * operator's config stays data-only. The factory may be `async`.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GguiJsonV1 } from './schema.js';

/**
 * The export name callers should use on their mount module. A default
 * export is also accepted when this named export is absent; the named
 * form is preferred because it gives readers a visible symbol at the
 * declaration site (`export function createGguiMcpMount() { ... }`).
 */
export const GGUI_MCP_MOUNT_FACTORY_EXPORT = 'createGguiMcpMount';

/**
 * Result of a successfully resolved + imported + invoked mount
 * declaration. The `mount` field is validated structurally — callers
 * (the CLI) narrow `handlers: unknown[]` to the concrete
 * `SharedHandler[]` at the adapter boundary. See module-level JSDoc
 * for the reason project-config does not import the server's type.
 */
export interface DiscoveredMcpMount {
  /** The module specifier as it appeared in `ggui.json#mcpMounts`. */
  readonly spec: string;
  /** Absolute filesystem path to the resolved module. */
  readonly modulePath: string;
  /** The factory's return — validated to have `{ name, handlers }`. */
  readonly mount: {
    readonly name: string;
    readonly handlers: ReadonlyArray<unknown>;
  };
}

/** Issue shape matches blueprint / primitive discovery so CLI renderers
 *  can treat all three streams uniformly. */
export interface McpMountDiscoveryIssue {
  /**
   * The offending declared spec (not a filesystem path) — resolution
   * may have failed before we located a file.
   */
  path: string;
  message: string;
  /** Underlying cause (resolver error, `SyntaxError`, factory throw). */
  cause?: unknown;
}

export interface McpMountDiscoveryResult {
  /** Mounts that resolved + imported + produced a valid shape, in
   *  declaration order. */
  mounts: DiscoveredMcpMount[];
  /** Per-source issues. Non-empty = operator action required; `ggui
   *  serve` escalates to a fatal exit before binding. */
  issues: McpMountDiscoveryIssue[];
}

/**
 * Options for {@link discoverMcpMounts}. `resolveModule` +
 * `importModule` are exposed so tests can avoid building real
 * `node_modules/` trees + real files — production callers omit both
 * and get `createRequire` + native dynamic `import()` defaults.
 */
export interface DiscoverMcpMountsOptions {
  /** Absolute project root — the directory containing `ggui.json`. */
  projectRoot: string;
  /** The parsed `ggui.json`. Only `mcpMounts` is consumed. */
  manifest: GguiJsonV1;
  /**
   * Hook for tests — given the declared specifier and the project
   * root, return the absolute path to the module file. Production
   * callers omit this; the default resolves relative paths against
   * the project root and bare specs through `createRequire`.
   */
  resolveModule?: (spec: string, projectRoot: string) => string;
  /**
   * Hook for tests — given a `file://…` URL, return the module's
   * namespace object (or equivalent). Production callers omit this;
   * the default uses native dynamic `import()`.
   */
  importModule?: (fileUrl: string) => Promise<unknown>;
}

/**
 * Walk `ggui.json#mcpMounts` and produce resolved + invoked mount
 * payloads. Non-throwing per source; each failure lands on `issues`.
 *
 * Ordering: `mounts` preserves declaration order (so collision errors
 * inside `composeHandlersWithMounts` deterministically blame the
 * later-declared duplicate). `issues` likewise preserves declaration
 * order so CLI renderers can print "issue #1 first" if they want.
 */
export async function discoverMcpMounts(
  options: DiscoverMcpMountsOptions,
): Promise<McpMountDiscoveryResult> {
  const { projectRoot, manifest } = options;

  if (!isAbsolute(projectRoot)) {
    throw new Error(
      `discoverMcpMounts: projectRoot must be absolute, got ${projectRoot}`,
    );
  }

  const specs = manifest.mcpMounts;
  const mounts: DiscoveredMcpMount[] = [];
  const issues: McpMountDiscoveryIssue[] = [];

  if (specs.length === 0) return { mounts, issues };

  const resolveModule =
    options.resolveModule ?? makeDefaultResolver(projectRoot);
  const importModule =
    options.importModule ?? ((url: string) => import(url));

  for (const spec of specs) {
    let modulePath: string;
    try {
      modulePath = resolveModule(spec, projectRoot);
    } catch (cause) {
      issues.push({
        path: spec,
        message:
          `Could not resolve mcpMounts entry "${spec}" — is the file present or the package installed? ` +
          `(${errorMessage(cause)})`,
        cause,
      });
      continue;
    }

    let mod: unknown;
    try {
      mod = await importModule(pathToFileURL(modulePath).href);
    } catch (cause) {
      issues.push({
        path: spec,
        message:
          `Failed to import mcpMounts entry "${spec}" (${modulePath}): ${errorMessage(cause)}`,
        cause,
      });
      continue;
    }

    const factory = pickFactory(mod);
    if (factory === null) {
      issues.push({
        path: spec,
        message:
          `mcpMounts entry "${spec}" must export a \`${GGUI_MCP_MOUNT_FACTORY_EXPORT}\` function ` +
          `(or a default export that is a function) returning { name, handlers }. Got: ${describeModule(mod)}.`,
      });
      continue;
    }

    let payload: unknown;
    try {
      payload = await factory();
    } catch (cause) {
      issues.push({
        path: spec,
        message: `mcpMounts entry "${spec}" factory threw during invocation: ${errorMessage(cause)}`,
        cause,
      });
      continue;
    }

    const validated = validateMountShape(payload);
    if (!validated.ok) {
      issues.push({
        path: spec,
        message: `mcpMounts entry "${spec}" factory returned an unexpected shape: ${validated.message}`,
      });
      continue;
    }

    mounts.push({
      spec,
      modulePath,
      mount: validated.mount,
    });
  }

  return { mounts, issues };
}

// ─────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────

/**
 * Default resolver: relative paths resolve filesystem-wise against
 * the project root (with an `existsSync` gate so a missing file
 * produces a sharp error message, not a noisy `createRequire` trace);
 * bare specifiers resolve through `createRequire` anchored at the
 * project root.
 */
function makeDefaultResolver(
  projectRoot: string,
): (spec: string, projectRoot: string) => string {
  // Anchor at `<projectRoot>/package.json` — same convention the
  // primitive resolver uses. `createRequire` doesn't require the
  // anchor file to exist; Node uses the path only to establish the
  // ancestor `node_modules/` resolution chain.
  const originUrl = pathToFileURL(join(projectRoot, 'package.json')).href;
  const req = createRequire(originUrl);
  return (spec) => {
    if (spec.startsWith('./') || spec.startsWith('../') || isAbsolute(spec)) {
      const resolved = resolve(projectRoot, spec);
      if (!existsSync(resolved)) {
        throw new Error(
          `relative mcpMounts path "${spec}" resolved to ${resolved}, which does not exist`,
        );
      }
      return resolved;
    }
    return req.resolve(spec);
  };
}

function pickFactory(
  mod: unknown,
): ((options?: unknown) => unknown | Promise<unknown>) | null {
  if (mod === null || typeof mod !== 'object') return null;
  const record = mod as Record<string, unknown>;
  const named = record[GGUI_MCP_MOUNT_FACTORY_EXPORT];
  if (typeof named === 'function') {
    return named as (options?: unknown) => unknown | Promise<unknown>;
  }
  const dflt = record['default'];
  if (typeof dflt === 'function') {
    return dflt as (options?: unknown) => unknown | Promise<unknown>;
  }
  return null;
}

type ValidationResult =
  | { ok: true; mount: DiscoveredMcpMount['mount'] }
  | { ok: false; message: string };

function validateMountShape(payload: unknown): ValidationResult {
  if (payload === null || typeof payload !== 'object') {
    return {
      ok: false,
      message: `expected an object shaped { name: string; handlers: [] }, got ${typeof payload}`,
    };
  }
  const obj = payload as Record<string, unknown>;
  const name = obj['name'];
  if (typeof name !== 'string' || name.length === 0) {
    return {
      ok: false,
      message:
        `\`name\` must be a non-empty string (used in collision-error messages + composition telemetry)`,
    };
  }
  const handlers = obj['handlers'];
  if (!Array.isArray(handlers)) {
    return {
      ok: false,
      message: `\`handlers\` must be an array (received: ${typeof handlers})`,
    };
  }
  return {
    ok: true,
    mount: {
      name,
      handlers: handlers as ReadonlyArray<unknown>,
    },
  };
}

function describeModule(mod: unknown): string {
  if (mod === null || typeof mod !== 'object') return typeof mod;
  const keys = Object.keys(mod as Record<string, unknown>);
  return keys.length === 0 ? '(no exports)' : `exports: ${keys.join(', ')}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
