/**
 * Node-only filesystem helpers for `ggui.json`.
 *
 * Lives on the `@ggui-ai/project-config/node` subpath (not the root
 * barrel) because it imports `node:fs` / `node:path`. Pulling those
 * builtins into the root barrel would break browser bundlers that
 * resolve `@ggui-ai/project-config` directly (webpack refuses the
 * `node:` scheme). The schema + parser in `./schema.ts` stay
 * browser-safe and are re-exported both from here and from the root
 * barrel.
 *
 * Intended callers:
 *
 * - Open `ggui` CLI (local dev / run / pair / serve / bench). Walks
 *   upward from `process.cwd()` to find the project-root file.
 * - Any hosting integration that reads the open manifest to
 *   reconstitute an agent. Hosting layers treat `ggui.json` as
 *   input-only; per-tenant overlay config lives outside this package.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CLIENT_SUPPORTED_VERSIONS,
  PROTOCOL_VERSION,
  UPGRADE_REQUIRED,
} from '@ggui-ai/protocol';
import {
  GGUI_JSON_FILENAME,
  GguiJsonV1,
  parseGguiJson,
} from './schema.js';

/** How many parent directories `findGguiJson` will walk by default. */
export const DEFAULT_FIND_MAX_DEPTH = 8;

/**
 * Walk up from `startDir` (default: `process.cwd()`) looking for a
 * `ggui.json`. Returns the absolute path to the first match, or
 * `null` if no file is found within `maxDepth` levels.
 *
 * Stops when the filesystem root is reached, regardless of `maxDepth`.
 * Never throws — a missing file is a valid result ("not in a ggui
 * project"), not an error.
 */
export function findGguiJson(
  startDir: string = process.cwd(),
  maxDepth: number = DEFAULT_FIND_MAX_DEPTH,
): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i <= maxDepth; i++) {
    const candidate = join(dir, GGUI_JSON_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Error thrown when a `ggui.json` fails to load — missing file,
 * malformed JSON, or schema validation failure. Wraps the underlying
 * cause (`SyntaxError` / `ZodError`) on `.cause` so callers can
 * inspect issue lists when they need to.
 */
export class GguiJsonLoadError extends Error {
  readonly path: string;

  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GguiJsonLoadError';
    this.path = path;
  }
}

/**
 * How the loader treats a `protocol` declaration that is not in
 * `CLIENT_SUPPORTED_VERSIONS` — the handshake's own knob: the same two
 * postures and the same default (`reject`). A refusal, or a diagnostic
 * that lets the load proceed. There is no third posture.
 */
export type GguiJsonVersionPolicy = 'advisory' | 'reject';

/**
 * The loader's protocol finding. Under `reject` it rides the thrown
 * {@link GguiJsonProtocolUnsupportedError}; under `advisory` it reaches
 * {@link LoadGguiJsonOptions.onDiagnostic} and the load continues.
 */
export interface GguiJsonProtocolDiagnostic {
  readonly kind: 'protocol-unsupported';
  /** The canonical wire code — the loader's outcome IS the handshake's. */
  readonly code: typeof UPGRADE_REQUIRED;
  /** The `protocol` the file declares. */
  readonly declared: string;
  /** The set this installation speaks (`CLIENT_SUPPORTED_VERSIONS`). */
  readonly supported: readonly string[];
  /** The current stamp (`PROTOCOL_VERSION`) — what a fresh declaration writes. */
  readonly current: string;
  readonly path: string;
  readonly message: string;
}

export interface LoadGguiJsonOptions {
  /** @default 'reject' */
  readonly versionPolicy?: GguiJsonVersionPolicy;
  /** Receives the diagnostic under `'advisory'`; under `'reject'` the same facts ride the error. */
  readonly onDiagnostic?: (diagnostic: GguiJsonProtocolDiagnostic) => void;
}

/**
 * The loader's version refusal: the file declares a `protocol` outside
 * `CLIENT_SUPPORTED_VERSIONS`, so nothing built on this installation
 * can speak to it. `.code` is the canonical `UPGRADE_REQUIRED` —
 * symmetric with the handshake's error frame — and `declared` /
 * `supported` / `current` carry what an author needs to fix the file.
 *
 * A subclass of {@link GguiJsonLoadError}, so every existing catch site
 * (and {@link safeLoadGguiJson}) handles it unchanged.
 */
export class GguiJsonProtocolUnsupportedError extends GguiJsonLoadError {
  readonly code: typeof UPGRADE_REQUIRED = UPGRADE_REQUIRED;
  readonly declared: string;
  readonly supported: readonly string[];
  readonly current: string;

  constructor(diagnostic: GguiJsonProtocolDiagnostic) {
    super(diagnostic.message, diagnostic.path);
    this.name = 'GguiJsonProtocolUnsupportedError';
    this.declared = diagnostic.declared;
    this.supported = diagnostic.supported;
    this.current = diagnostic.current;
  }
}

/**
 * Membership, not currency, is the contract: the declaration must be
 * IN the supported set — the wire's own predicate, one predicate for
 * the file and the handshake. Never `=== PROTOCOL_VERSION`: the day the
 * set has two members an exact-stamp check would refuse a declaration
 * the wire accepts.
 *
 * In-set-but-not-current ("stale") is diagnostic-only by ruling and
 * never a refusal. It is unreachable while the set is a singleton; add
 * that diagnostic, with its test, when a second member lands.
 */
function checkProtocolMembership(
  doc: GguiJsonV1,
  path: string,
  options: LoadGguiJsonOptions,
): void {
  if (CLIENT_SUPPORTED_VERSIONS.includes(doc.protocol)) return;
  const diagnostic: GguiJsonProtocolDiagnostic = {
    kind: 'protocol-unsupported',
    code: UPGRADE_REQUIRED,
    declared: doc.protocol,
    supported: CLIENT_SUPPORTED_VERSIONS,
    current: PROTOCOL_VERSION,
    path,
    message:
      `ggui.json at ${path} declares protocol '${doc.protocol}', which this ` +
      `installation does not speak (supported: [${CLIENT_SUPPORTED_VERSIONS.join(', ')}]). ` +
      `Set "protocol" to '${PROTOCOL_VERSION}' (the current version), or install the ` +
      `@ggui-ai/* packages that speak '${doc.protocol}'.`,
  };
  if ((options.versionPolicy ?? 'reject') === 'reject') {
    throw new GguiJsonProtocolUnsupportedError(diagnostic);
  }
  options.onDiagnostic?.(diagnostic);
}

/**
 * Read `ggui.json` at `path`, parse JSON, validate against the v1
 * schema, and check the declared `protocol` against what this
 * installation speaks. Returns the fully-defaulted document.
 *
 * Throws {@link GguiJsonLoadError} if:
 *   - the file does not exist,
 *   - the file is not valid JSON,
 *   - the document fails schema validation (cause set to `ZodError`),
 *   - the declared `protocol` is not in `CLIENT_SUPPORTED_VERSIONS` and
 *     `options.versionPolicy` is `'reject'` (the default) — as the
 *     {@link GguiJsonProtocolUnsupportedError} subclass, carrying
 *     `UPGRADE_REQUIRED`. Under `'advisory'` that state loads and
 *     reaches `options.onDiagnostic` instead.
 */
export function loadGguiJson(
  path: string,
  options: LoadGguiJsonOptions = {},
): GguiJsonV1 {
  if (!existsSync(path)) {
    throw new GguiJsonLoadError(`ggui.json not found at ${path}`, path);
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (cause) {
    throw new GguiJsonLoadError(
      `Failed to read ggui.json at ${path}`,
      path,
      { cause },
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    throw new GguiJsonLoadError(
      `ggui.json at ${path} is not valid JSON`,
      path,
      { cause },
    );
  }

  let doc: GguiJsonV1;
  try {
    doc = parseGguiJson(decoded);
  } catch (cause) {
    throw new GguiJsonLoadError(
      `ggui.json at ${path} failed schema validation`,
      path,
      { cause },
    );
  }

  // Outside the schema `try`: a version refusal is its own outcome,
  // never re-wrapped as a schema failure.
  checkProtocolMembership(doc, path, options);
  return doc;
}

/**
 * Result of {@link safeLoadGguiJson} — mirrors `z.safeParse` so
 * consumers can branch without try/catch.
 */
export type SafeLoadResult =
  | { success: true; data: GguiJsonV1 }
  | { success: false; error: GguiJsonLoadError };

/**
 * Non-throwing variant of {@link loadGguiJson}. Returns a
 * discriminated result. Use this in CLI surfaces that render issue
 * lists directly. Same `options` and the same protocol default: an
 * unsupported declaration comes back as `{ success: false, error }`
 * with the {@link GguiJsonProtocolUnsupportedError}.
 */
export function safeLoadGguiJson(
  path: string,
  options: LoadGguiJsonOptions = {},
): SafeLoadResult {
  try {
    return { success: true, data: loadGguiJson(path, options) };
  } catch (error) {
    if (error instanceof GguiJsonLoadError) {
      return { success: false, error };
    }
    throw error;
  }
}

/**
 * Serialize and write a `ggui.json` document to `path`. The input is
 * re-validated against the v1 schema before writing so a caller
 * cannot accidentally persist a document that wouldn't round-trip
 * through {@link loadGguiJson}.
 *
 * Output format: 2-space indent, trailing newline.
 */
export function saveGguiJson(path: string, doc: GguiJsonV1): void {
  const validated = parseGguiJson(doc);
  writeFileSync(path, JSON.stringify(validated, null, 2) + '\n', 'utf-8');
}

// Re-export schema + parser from the same subpath so Node callers
// can do `import { parseGguiJson, loadGguiJson } from
// '@ggui-ai/project-config/node'` without two imports. Browser callers
// use the root barrel, which exports the browser-safe subset.
export {
  GGUI_JSON_FILENAME,
  GguiJsonV1,
  parseGguiJson,
  safeParseGguiJson,
} from './schema.js';

// Filesystem-backed blueprint manifest discovery. Lives here (not the
// browser-safe root barrel) because it imports `node:fs/promises` +
// `tinyglobby`. Consumed by `@ggui-ai/dev-stack` (for the `ggui dev`
// hub) and `@ggui-ai/mcp-server` (for `ggui serve` boot wiring).
export {
  discoverLocalUis,
  discoverFromGguiJsonPath,
  type DiscoveredUi,
  type DiscoveryIssue,
  type DiscoveryResult,
  type DiscoverOptions,
} from './discovery.js';

// Filesystem + Node-module-resolution backed primitive manifest
// discovery. Symmetric with blueprint discovery above but resolves
// npm specifiers through `createRequire` rather than glob-only.
// Consumed by `@ggui-ai/mcp-server` at `ggui serve` boot to index
// every primitive source declared in `ggui.json#primitives`.
export {
  discoverPrimitives,
  discoverPrimitivesFromGguiJsonPath,
  type DiscoveredPrimitiveCatalog,
  type PrimitiveDiscoveryIssue,
  type PrimitiveDiscoveryResult,
  type DiscoverPrimitivesOptions,
} from './primitive-discovery.js';

// Node-only resolution of `ggui.json#mcpMounts`. Dynamic-imports each
// declared module, invokes its `createGguiMcpMount` factory, and
// returns structurally-validated mount payloads. Consumed by
// `@ggui-ai/cli` at `ggui serve` boot to thread operator-declared
// tool bundles through `createGguiServer({ mcpMounts })`.
export {
  discoverMcpMounts,
  GGUI_MCP_MOUNT_FACTORY_EXPORT,
  type DiscoveredMcpMount,
  type McpMountDiscoveryIssue,
  type McpMountDiscoveryResult,
  type DiscoverMcpMountsOptions,
} from './mcp-mount-discovery.js';

// Browser-safe primitive manifest schema + parsers re-exported here
// too so Node callers get the full surface from one import path.
export {
  GGUI_PRIMITIVES_JSON_FILENAME,
  PrimitivesManifestV1,
  parsePrimitivesManifest,
  safeParsePrimitivesManifest,
  type PrimitivesManifest,
} from './primitives-manifest.js';

// Browser-safe theme document schema + parsers — re-exported on the
// Node subpath so `ggui serve` / `ggui dev` get the full theme
// surface from one import path. See `./theme.js` for the v1
// plain-DTCG contract.
export {
  ThemeDocumentV1,
  parseThemeDocument,
  safeParseThemeDocument,
  type ThemeDocument,
} from './theme.js';

// Filesystem-backed theme loader — consumes `ggui.json#theme`,
// resolves it against the project root, parses + validates, and
// returns a `LoadedTheme` ready for the OSS `ggui serve` server.
// Non-throwing per-file; the CLI escalates issues to fatal at boot.
export {
  loadTheme,
  loadThemeFromGguiJsonPath,
  type LoadedTheme,
  type LoadThemeOptions,
  type LoadThemeResult,
  type ThemeLoadIssue,
} from './theme-loader.js';
