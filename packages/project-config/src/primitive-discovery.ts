/**
 * Primitive manifest discovery — turns a loaded `ggui.json` into the
 * set of primitive catalogs the project declares via
 * `primitives.packages` (npm specifiers) and `primitives.local`
 * (globs).
 *
 * The flow:
 *
 *   ggui.json.primitives.packages (npm specifiers)
 *     → resolve each spec through Node's module resolution
 *     → walk up to the enclosing `package.json`
 *     → read `ggui.primitives.json` alongside it
 *     → parse via {@link parsePrimitivesManifest}
 *
 *   ggui.json.primitives.local (globs relative to project root)
 *     → filesystem match (tinyglobby, same options as blueprint
 *       discovery)
 *     → filter to basename === `ggui.primitives.json`
 *     → parse via {@link parsePrimitivesManifest}
 *
 * For npm specifiers, the resolver walks UP from the resolved subpath
 * file to find the enclosing `package.json` — this avoids requiring
 * packages to add `ggui.primitives.json` to their `exports` block and
 * matches the intuition that "the manifest lives at the package root".
 *
 * ## Error model
 *
 * Discovery never throws on a per-source failure. One malformed
 * manifest should not black-hole the rest of the project — the
 * `ggui dev` hub renders the valid catalogs + flags the bad ones in
 * the UI. Each issue carries a path + message so callers can render
 * a useful list.
 *
 * Callers that need fail-fast semantics (e.g. `ggui serve` boot,
 * where continuing with a partial set is a silent deploy-time
 * regression) inspect `result.issues` themselves and escalate to a
 * thrown error when non-empty. This helper stays policy-neutral —
 * mirrors the blueprint-discovery split.
 *
 * ## Why `@ggui-ai/project-config/node`, not a sibling package
 *
 * Discovery is filesystem + parse + identity check. It is NOT HTTP,
 * agent runtime, or generator state. Consumers today:
 *
 *   - `@ggui-ai/mcp-server` at `ggui serve` boot time — builds the
 *     primitive index so future generator consumers can enumerate
 *     every declared source.
 *   - `@ggui-ai/dev-stack` may consume it later for a unified
 *     `ggui dev` hub view (symmetric with blueprint discovery).
 *
 * Housing it here keeps one source of truth and avoids an inbound
 * dep on either consumer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { glob } from 'tinyglobby';
import type { GguiJsonV1 } from './schema.js';
import {
  GGUI_PRIMITIVES_JSON_FILENAME,
  parsePrimitivesManifest,
  type PrimitivesManifest,
} from './primitives-manifest.js';

/**
 * One discovered primitive catalog — the import specifier + absolute
 * manifest path + the parsed manifest. Callers address by `import`;
 * paths drive doc-file lookups and informational output.
 */
export interface DiscoveredPrimitiveCatalog {
  /**
   * Where the source came from. `'package'` = resolved through an
   * npm specifier declared in `ggui.json#primitives.packages`;
   * `'local'` = matched by a glob in `ggui.json#primitives.local`.
   * Renderers may use this to annotate the catalog differently.
   */
  source: 'package' | 'local';
  /**
   * The specifier consumers import from (equal to `manifest.import`).
   * Keyed separately from the manifest so callers don't have to
   * reach into the nested shape for the common case.
   */
  import: string;
  /** Absolute path to the discovered `ggui.primitives.json`. */
  manifestPath: string;
  /** Parsed manifest. */
  manifest: PrimitivesManifest;
}

/**
 * An error surfaced during discovery. Shape matches
 * {@link DiscoveryIssue} from blueprint discovery so CLI renderers
 * can treat both issue streams identically.
 */
export interface PrimitiveDiscoveryIssue {
  /**
   * Path or specifier of the offending source. For `packages`
   * entries this is the declared npm specifier (not a filesystem
   * path) since resolution may have failed before we could locate
   * a file. For `local` entries this is a relative path under the
   * project root.
   */
  path: string;
  message: string;
  /** Underlying cause (typically `ZodError`, `SyntaxError`, or the resolver error). */
  cause?: unknown;
}

/** Result of a full primitive-discovery pass. */
export interface PrimitiveDiscoveryResult {
  /** Successfully parsed catalogs. Ordering: packages first (in declaration order),
   *  then local (filesystem-walk order from tinyglobby). */
  catalogs: DiscoveredPrimitiveCatalog[];
  /** Issues that should be rendered to the user; discovery still returns. */
  issues: PrimitiveDiscoveryIssue[];
}

/**
 * Options for {@link discoverPrimitives}. `resolveModule` is exposed
 * so tests can inject a fake resolver; real callers omit it and get
 * the Node `createRequire` default anchored at `projectRoot`.
 */
export interface DiscoverPrimitivesOptions {
  /**
   * Absolute project root — the directory containing `ggui.json`.
   * Globs in `primitives.local` resolve relative to this directory;
   * npm specifiers in `primitives.packages` resolve through a
   * `require` anchored here.
   */
  projectRoot: string;
  /** The parsed `ggui.json`. Only `primitives.{packages,local}` is consumed. */
  manifest: GguiJsonV1;
  /**
   * Hook for tests — given the declared specifier and the project
   * root, return the absolute path to a representative file inside
   * the package (any file that lets us walk UP to the enclosing
   * `package.json`). Throw to signal "not resolvable". Production
   * callers omit this; the default resolver uses `createRequire`
   * against `<projectRoot>/package.json`.
   */
  resolveModule?: (specifier: string, projectRoot: string) => string;
}

/**
 * Walk both `primitives.packages` and `primitives.local`, build the
 * catalog, accumulate issues.
 *
 * Non-throwing per source. Duplicate-`import`-specifier across
 * sources is an issue (first-seen wins, later ones accumulate as
 * issues). A glob pattern that matches nothing is allowed — the
 * manifest may exist ahead of primitives being authored; operators
 * can still run `ggui dev` without the catalog being complete.
 */
export async function discoverPrimitives(
  options: DiscoverPrimitivesOptions,
): Promise<PrimitiveDiscoveryResult> {
  const { projectRoot, manifest } = options;

  if (!isAbsolute(projectRoot)) {
    throw new Error(
      `discoverPrimitives: projectRoot must be absolute, got ${projectRoot}`,
    );
  }

  const catalogs: DiscoveredPrimitiveCatalog[] = [];
  const issues: PrimitiveDiscoveryIssue[] = [];
  const seenImports = new Map<string, string>(); // import → manifestPath

  const resolveModule =
    options.resolveModule ?? makeDefaultModuleResolver(projectRoot);

  // ── packages: npm specifiers ────────────────────────────────────
  for (const spec of manifest.primitives.packages) {
    let entryPath: string;
    try {
      entryPath = resolveModule(spec, projectRoot);
    } catch (cause) {
      issues.push({
        path: spec,
        message:
          `Could not resolve primitive package "${spec}" — is it installed in the project? ` +
          `(${errorMessage(cause)})`,
        cause,
      });
      continue;
    }

    const pkgRoot = findEnclosingPackageRoot(entryPath);
    if (!pkgRoot) {
      issues.push({
        path: spec,
        message:
          `Primitive package "${spec}" resolved to ${entryPath}, but no enclosing package.json was found.`,
      });
      continue;
    }

    const manifestPath = join(pkgRoot, GGUI_PRIMITIVES_JSON_FILENAME);
    if (!existsSync(manifestPath)) {
      issues.push({
        path: spec,
        message:
          `Primitive package "${spec}" is missing ${GGUI_PRIMITIVES_JSON_FILENAME} at its root (${pkgRoot}). ` +
          `Expected convention: one ggui.primitives.json alongside package.json.`,
      });
      continue;
    }

    const parsed = loadManifestAt(manifestPath, spec);
    if (!parsed.ok) {
      issues.push(parsed.issue);
      continue;
    }

    // The declared `ggui.json` spec MUST match the manifest's own
    // `import` field. A mismatch means the operator declared the
    // wrong package name OR the package is advertising a different
    // specifier — either way, the generator's import-line would be
    // wrong. Surface it here rather than hand the agent a broken
    // catalog.
    if (parsed.manifest.import !== spec) {
      issues.push({
        path: spec,
        message:
          `Primitive package "${spec}" declares import="${parsed.manifest.import}" in its ` +
          `ggui.primitives.json, but ggui.json lists it under primitives.packages as "${spec}". ` +
          `These must match — either update ggui.json's entry or the package's manifest.`,
      });
      continue;
    }

    recordCatalog(catalogs, issues, seenImports, {
      source: 'package',
      import: parsed.manifest.import,
      manifestPath,
      manifest: parsed.manifest,
    });
  }

  // ── local: globs ────────────────────────────────────────────────
  const localPatterns = manifest.primitives.local;
  if (localPatterns.length > 0) {
    const matches = await glob(localPatterns, {
      cwd: projectRoot,
      absolute: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      dot: false,
    });

    for (const absolutePath of matches) {
      const rel = relative(projectRoot, absolutePath);
      const displayPath = rel === '' ? absolutePath : rel;

      // Mirror blueprint discovery's wide-`**` safety — skip matches
      // whose basename isn't the canonical filename. Users sometimes
      // write `ui/**/*.json` patterns and pick up arbitrary JSON.
      if (!absolutePath.endsWith(sep + GGUI_PRIMITIVES_JSON_FILENAME)) {
        continue;
      }

      const parsed = loadManifestAt(absolutePath, displayPath);
      if (!parsed.ok) {
        issues.push(parsed.issue);
        continue;
      }

      recordCatalog(catalogs, issues, seenImports, {
        source: 'local',
        import: parsed.manifest.import,
        manifestPath: absolutePath,
        manifest: parsed.manifest,
      });
    }
  }

  return { catalogs, issues };
}

/**
 * Convenience wrapper for the common "I have a `ggui.json` path,
 * give me the primitives" flow. Resolves the project root from the
 * manifest path.
 */
export async function discoverPrimitivesFromGguiJsonPath(
  manifestPath: string,
  manifest: GguiJsonV1,
  extra: Omit<DiscoverPrimitivesOptions, 'projectRoot' | 'manifest'> = {},
): Promise<PrimitiveDiscoveryResult> {
  const projectRoot = dirname(resolve(manifestPath));
  return discoverPrimitives({ projectRoot, manifest, ...extra });
}

// ─────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────

function makeDefaultModuleResolver(
  projectRoot: string,
): (specifier: string, _projectRoot: string) => string {
  // Anchor at `<projectRoot>/package.json` — the file doesn't have
  // to exist for resolution to produce a working answer; Node uses
  // the path only to establish the ancestor `node_modules/` chain.
  //
  // We use `import.meta.resolve` rather than `createRequire().resolve`
  // because primitive packages (`@ggui-ai/design`, sibling catalogs
  // operators may author) are ESM-only — their `package.json#exports`
  // declare only the `"import"` condition per the open-source
  // subtree's `"type": "module"` convention. CommonJS `require.resolve`
  // cannot satisfy a subpath whose `exports` entry has no `"require"`
  // condition, even though the subpath IS defined for ESM consumers —
  // the resolver throws `ERR_PACKAGE_PATH_NOT_EXPORTED` with a
  // misleading "not defined by exports" message.
  //
  // Crucially, discovery never actually `require()`s the resolved
  // entry; it only walks UP from the entry path to find the enclosing
  // `package.json` (see `findEnclosingPackageRoot` above). So using
  // an ESM-native resolver is both honest (matches the package's
  // actual condition set) and safe (no downstream CJS load).
  //
  // `import.meta.resolve(spec, parent)` is stable + synchronous in
  // Node 20+. The returned URL is converted back to a filesystem path
  // with `fileURLToPath` so the rest of the pipeline stays
  // path-based.
  const originUrl = pathToFileURL(join(projectRoot, 'package.json')).href;
  return (specifier) => fileURLToPath(import.meta.resolve(specifier, originUrl));
}

function findEnclosingPackageRoot(startFile: string): string | null {
  let dir = dirname(resolve(startFile));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

type LoadResult =
  | { ok: true; manifest: PrimitivesManifest }
  | { ok: false; issue: PrimitiveDiscoveryIssue };

function loadManifestAt(absolutePath: string, displayPath: string): LoadResult {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf-8');
  } catch (cause) {
    return {
      ok: false,
      issue: {
        path: displayPath,
        message: `Could not read ${GGUI_PRIMITIVES_JSON_FILENAME}: ${errorMessage(cause)}`,
        cause,
      },
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      issue: {
        path: displayPath,
        message: `${GGUI_PRIMITIVES_JSON_FILENAME} is not valid JSON: ${errorMessage(cause)}`,
        cause,
      },
    };
  }

  try {
    const manifest = parsePrimitivesManifest(decoded);
    return { ok: true, manifest };
  } catch (cause) {
    return {
      ok: false,
      issue: {
        path: displayPath,
        message: `${GGUI_PRIMITIVES_JSON_FILENAME} failed schema validation: ${errorMessage(cause)}`,
        cause,
      },
    };
  }
}

function recordCatalog(
  catalogs: DiscoveredPrimitiveCatalog[],
  issues: PrimitiveDiscoveryIssue[],
  seenImports: Map<string, string>,
  candidate: DiscoveredPrimitiveCatalog,
): void {
  const prior = seenImports.get(candidate.import);
  if (prior !== undefined) {
    issues.push({
      path: candidate.manifestPath,
      message:
        `Duplicate primitive import specifier "${candidate.import}" — already declared by ${prior}. ` +
        `Two sources cannot claim the same specifier (the generator would emit duplicate import lines).`,
    });
    return;
  }
  seenImports.set(candidate.import, candidate.manifestPath);
  catalogs.push(candidate);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
