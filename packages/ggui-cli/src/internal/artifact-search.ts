/**
 * `ggui gadget search [q]` — query the marketplace registry's
 * `GET /search` endpoint and render results.
 *
 * The consumer-side discovery surface, companion to `gadget create`
 * and `gadget publish`. Public and unauthenticated; the registry's
 * `/search` route returns only `visibility: "public"` rows.
 *
 * Three-layer registry resolution (highest priority wins, mirrors
 * `gadget publish` + `ggui install`):
 *
 *   1. `--registry <url>` flag.
 *   2. `GGUI_REGISTRY` environment variable.
 *   3. `ggui.json#registry` field (walks up from `cwd`).
 *   4. Error if unset — no hard-coded default.
 *
 * Kept pure / testable — no `process.exit`, no direct stdout writes.
 * Returns a `SearchOutput` discriminated union; the CLI driver in
 * `gadget-command.ts` renders copy + picks the exit code.
 *
 * The wire shapes (`SearchResultEntry` / `SearchResponse` /
 * `ArtifactKind`) are imported from `@ggui-ai/registry-core` — the
 * canonical owner of the registry HTTP response types — and
 * re-exported for this module's consumers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  SEARCH_ERROR_CODES,
  type ArtifactKind,
  type SearchErrorBody,
  type SearchResponse,
  type SearchResultEntry,
} from '@ggui-ai/registry-core';

export type { ArtifactKind, SearchResponse, SearchResultEntry };

/**
 * Filename constant for the project manifest. Duplicated from
 * `@ggui-ai/project-config` rather than imported to keep this
 * subcommand from pulling in the full project-config dependency tree.
 */
const GGUI_JSON_FILENAME = 'ggui.json';
/** How many parent directories the upward walk will inspect. */
const FIND_MAX_DEPTH = 8;

/* -------------------------------------------------------------------------- */
/* Flag parsing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Flag bundle accepted by {@link runArtifactSearch}. Mirrors the CLI's
 * positional + flag surface. Built either from `process.argv` (via
 * {@link parseArtifactSearchFlags}) or from object literals in tests.
 */
export interface ArtifactSearchFlags {
  /** Optional positional. Maps to the `q` query param. */
  readonly q?: string;
  /** Filter on `kind`. */
  readonly kind?: ArtifactKind;
  /** Filter on `hook` (gadgets only). */
  readonly hook?: string;
  /** Filter on `tag` (exact match against any element of `row.tags`). */
  readonly tag?: string;
  /** Filter on `author` (caller subject id OR substring of authorName). */
  readonly author?: string;
  /** Page size. Registry caps at 200; default 50. */
  readonly limit?: number;
  /** Opaque cursor from a previous response. */
  readonly cursor?: string;
  /** Override registry URL. Beats env + ggui.json. */
  readonly registry?: string;
  /** Emit raw response JSON instead of the human-readable table. */
  readonly json?: boolean;
}

export interface ParsedSearchFlags {
  readonly flags?: ArtifactSearchFlags;
  /** `'__help__'` for `--help`; other strings = usage error. */
  readonly error?: string;
}

/**
 * Flag parser. Returns a discriminated `{error}` vs. `{flags}` so the
 * caller doesn't throw on user input. The `lockedKind` argument is the
 * verb the operator typed — when supplied (the kind-discriminated
 * router path), the `--kind` flag is rejected because the verb already
 * pins the value. When `undefined` (legacy generic-search path, not
 * exposed by the CLI today), `--kind` is honored as a freeform filter.
 *
 * For `lockedKind === 'blueprint'`, `--hook` is rejected because the
 * hook filter is a gadget-only concern.
 *
 * Accepts both `--flag value` and `--flag=value` for every option.
 */
export function parseArtifactSearchFlags(
  lockedKind: ArtifactKind | undefined,
  args: readonly string[],
): ParsedSearchFlags {
  let q: string | undefined;
  let kind: ArtifactKind | undefined = lockedKind;
  let hook: string | undefined;
  let tag: string | undefined;
  let author: string | undefined;
  let limit: number | undefined;
  let cursor: string | undefined;
  let registry: string | undefined;
  let json = false;

  /**
   * Pull the value for `--name`. Supports either `--name value` or
   * `--name=value`. Returns `null` if no value is available so the
   * caller can render the usage error.
   */
  function readValue(
    arg: string,
    nextIdx: number,
  ): { value: string; advance: number } | null {
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      const v = arg.slice(eq + 1);
      if (v.length === 0) return null;
      return { value: v, advance: 0 };
    }
    const next = args[nextIdx];
    if (typeof next !== 'string' || next.length === 0) return null;
    return { value: next, advance: 1 };
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      return { error: '__help__' };
    }
    if (arg === '--json') {
      json = true;
      continue;
    }

    if (
      arg.startsWith('--kind=') ||
      arg === '--kind' ||
      arg.startsWith('--hook=') ||
      arg === '--hook' ||
      arg.startsWith('--tag=') ||
      arg === '--tag' ||
      arg.startsWith('--author=') ||
      arg === '--author' ||
      arg.startsWith('--limit=') ||
      arg === '--limit' ||
      arg.startsWith('--cursor=') ||
      arg === '--cursor' ||
      arg.startsWith('--registry=') ||
      arg === '--registry'
    ) {
      const flagName = arg.startsWith('--')
        ? arg.split('=')[0]!.slice(2)
        : '';
      const read = readValue(arg, i + 1);
      if (read === null) {
        return { error: `--${flagName} requires a value` };
      }
      i += read.advance;
      const v = read.value;
      switch (flagName) {
        case 'kind':
          if (v !== 'gadget' && v !== 'blueprint') {
            return { error: '--kind must be "gadget" or "blueprint"' };
          }
          if (lockedKind !== undefined && v !== lockedKind) {
            return {
              error: `--kind=${v} conflicts with \`ggui ${lockedKind} search\`. Drop --kind, or use the matching verb (\`ggui ${v} search\`).`,
            };
          }
          kind = v;
          break;
        case 'hook':
          if (lockedKind === 'blueprint') {
            return {
              error:
                '--hook is a gadget-only filter; blueprints do not expose hooks. Use `ggui gadget search --hook <name>` instead.',
            };
          }
          hook = v;
          break;
        case 'tag':
          tag = v;
          break;
        case 'author':
          author = v;
          break;
        case 'limit': {
          const n = Number.parseInt(v, 10);
          if (!Number.isInteger(n) || n < 1 || n > 200) {
            return {
              error: '--limit must be an integer in [1, 200]',
            };
          }
          limit = n;
          break;
        }
        case 'cursor':
          cursor = v;
          break;
        case 'registry':
          registry = v;
          break;
      }
      continue;
    }

    if (arg.startsWith('--')) {
      return { error: `unknown flag: ${arg}` };
    }
    if (q === undefined) {
      q = arg;
      continue;
    }
    return { error: `unexpected positional argument: ${arg}` };
  }

  const flags: ArtifactSearchFlags = {
    ...(q !== undefined ? { q } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(hook !== undefined ? { hook } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(registry !== undefined ? { registry } : {}),
    ...(json ? { json: true } : {}),
  };
  return { flags };
}

/* -------------------------------------------------------------------------- */
/* Registry URL resolution                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Three-layer resolution: `--registry` flag > `GGUI_REGISTRY` env >
 * `ggui.json#registry` > error.
 *
 * `cwd` + `env` are injectable for tests. Returns either `{ url }` on
 * success or `{ error }` with a stderr-ready diagnostic. Trailing
 * slashes on the URL are normalized away so the URL builder can append
 * `/search?…` deterministically.
 */
export function resolveRegistryUrl(args: {
  flag?: string;
  cwd: string;
  env: { readonly GGUI_REGISTRY?: string | undefined };
}): { url: string } | { error: string } {
  const candidate =
    args.flag ??
    (typeof args.env.GGUI_REGISTRY === 'string' && args.env.GGUI_REGISTRY.length > 0
      ? args.env.GGUI_REGISTRY
      : undefined);

  if (typeof candidate === 'string' && candidate.length > 0) {
    return normalizeRegistryUrl(candidate);
  }

  const gguiJsonPath = findGguiJson(args.cwd);
  if (gguiJsonPath !== null) {
    const loaded = readGguiJsonRegistryField(gguiJsonPath);
    if ('error' in loaded) {
      return { error: loaded.error };
    }
    if (loaded.registry !== undefined) {
      return normalizeRegistryUrl(loaded.registry);
    }
  }

  return {
    error:
      'no registry configured. Pass --registry <url>, set GGUI_REGISTRY, or add `registry` to ggui.json.',
  };
}

/**
 * Walk up from `startDir` looking for a `ggui.json`. Returns the
 * absolute path of the first match, or `null` if none found within
 * {@link FIND_MAX_DEPTH} levels. Mirrors the algorithm in
 * `@ggui-ai/project-config/node`'s `findGguiJson` — duplicated here
 * to keep this subcommand free of the project-config dependency.
 */
function findGguiJson(startDir: string): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i <= FIND_MAX_DEPTH; i++) {
    const candidate = join(dir, GGUI_JSON_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Read just the `registry` field from a `ggui.json`. We don't run the
 * full schema parser here — that would couple this command to every
 * other field in the manifest, and a corrupt `gadgets` block
 * (unrelated to search) would prevent `gadget search` from running.
 * The field is validated structurally: must be a string. Schema-level
 * URL validation happens downstream in {@link normalizeRegistryUrl}.
 */
function readGguiJsonRegistryField(
  path: string,
): { registry: string | undefined } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return {
      error: `failed to read ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    return {
      error: `${path} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return { error: `${path} is not a JSON object` };
  }
  const reg = (decoded as { registry?: unknown }).registry;
  if (reg === undefined) return { registry: undefined };
  if (typeof reg !== 'string') {
    return { error: `${path}#registry must be a string` };
  }
  return { registry: reg };
}

function normalizeRegistryUrl(raw: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: `registry URL is malformed: ${raw}` };
  }
  // Strip trailing slashes so we can append `/search` deterministically.
  // `URL` already normalized scheme + host casing.
  let serialized = parsed.toString();
  while (serialized.endsWith('/')) serialized = serialized.slice(0, -1);
  return { url: serialized };
}

/* -------------------------------------------------------------------------- */
/* Query string                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a query string from {@link ArtifactSearchFlags}. Pulled out so
 * tests can assert the wire shape without a real fetch. Empty / absent
 * filters are dropped entirely (rather than emitted as `&foo=`).
 *
 * The returned string always starts with `?` unless every filter is
 * absent, in which case the empty string is returned.
 */
export function buildSearchQueryString(flags: ArtifactSearchFlags): string {
  const params = new URLSearchParams();
  if (flags.q !== undefined) params.set('q', flags.q);
  if (flags.kind !== undefined) params.set('kind', flags.kind);
  if (flags.hook !== undefined) params.set('hook', flags.hook);
  if (flags.tag !== undefined) params.set('tag', flags.tag);
  if (flags.author !== undefined) params.set('author', flags.author);
  if (flags.limit !== undefined) params.set('limit', String(flags.limit));
  if (flags.cursor !== undefined) params.set('cursor', flags.cursor);
  const qs = params.toString();
  return qs.length === 0 ? '' : `?${qs}`;
}

/* -------------------------------------------------------------------------- */
/* Output shape                                                              */
/* -------------------------------------------------------------------------- */

/** Successful response — keeps a normalized snapshot for rendering. */
export interface SearchSuccess {
  readonly ok: true;
  readonly registryUrl: string;
  readonly response: SearchResponse;
  /**
   * Pre-built human-readable lines, in order. Empty when `--json` is
   * passed (the CLI emits the raw JSON body instead). Pre-baking the
   * lines here keeps `gadget-command.ts` free of formatting logic and
   * lets tests assert the exact strings.
   */
  readonly lines: readonly string[];
  /** Convenience — the same data the JSON output would emit. */
  readonly json: string;
}

/** Structured failure. `code` is the stable error surface for tests. */
export interface SearchFailure {
  readonly ok: false;
  /** Machine-readable failure code. */
  readonly code:
    | 'no-registry'
    | 'invalid-registry'
    | 'network-error'
    | 'http-error'
    | 'bad-response';
  /** Human-readable diagnostic — safe to write to stderr verbatim. */
  readonly message: string;
}

export type SearchOutput = SearchSuccess | SearchFailure;

/* -------------------------------------------------------------------------- */
/* Core: runArtifactSearch                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Dependencies for {@link runArtifactSearch}. All injectable so tests
 * can stub `fetch` + env + cwd without touching globals.
 */
export interface RunArtifactSearchDeps {
  readonly cwd: string;
  readonly env: { readonly GGUI_REGISTRY?: string | undefined };
  readonly fetch: typeof fetch;
}

/**
 * Run a search end-to-end:
 *
 *   1. Resolve the registry URL via the three-layer chain.
 *   2. Build the query string.
 *   3. GET `<registry>/search?<qs>` (no auth; public endpoint).
 *   4. Parse + validate the response shape.
 *   5. Format human-readable lines (or stash raw JSON for `--json`).
 *
 * Never throws — every error path returns a {@link SearchFailure}.
 */
export async function runArtifactSearch(
  flags: ArtifactSearchFlags,
  deps: RunArtifactSearchDeps,
): Promise<SearchOutput> {
  const resolved = resolveRegistryUrl({
    ...(flags.registry !== undefined ? { flag: flags.registry } : {}),
    cwd: deps.cwd,
    env: deps.env,
  });
  if ('error' in resolved) {
    const isNoRegistryError = resolved.error.startsWith('no registry');
    return {
      ok: false,
      code: isNoRegistryError ? 'no-registry' : 'invalid-registry',
      message: resolved.error,
    };
  }

  const qs = buildSearchQueryString(flags);
  const url = `${resolved.url}/search${qs}`;

  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return {
      ok: false,
      code: 'network-error',
      message: `failed to reach registry at ${resolved.url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!res.ok) {
    // Try to surface the registry's structured error body. If parsing
    // fails we fall back to the status line — better than swallowing.
    let detail: string | undefined;
    try {
      const body: unknown = await res.json();
      if (isSearchErrorBody(body)) {
        detail = `${body.error}: ${body.message}`;
      }
    } catch {
      detail = undefined;
    }
    return {
      ok: false,
      code: 'http-error',
      message: `registry returned ${res.status}${
        detail !== undefined ? ` — ${detail}` : ''
      }`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      code: 'bad-response',
      message: `registry response is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!isSearchResponse(body)) {
    return {
      ok: false,
      code: 'bad-response',
      message:
        'registry response did not match the expected SearchResponse shape',
    };
  }

  const json = JSON.stringify(body, null, 2);
  const lines = flags.json === true ? [] : renderHumanLines(body, resolved.url);

  return {
    ok: true,
    registryUrl: resolved.url,
    response: body,
    lines,
    json,
  };
}

/* -------------------------------------------------------------------------- */
/* Response validation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Structural typeguard for {@link SearchResponse}. Rejects anything
 * that doesn't have a `results` array of entry-shaped objects.
 */
function isSearchResponse(v: unknown): v is SearchResponse {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as { results?: unknown; nextCursor?: unknown };
  if (!Array.isArray(obj.results)) return false;
  for (const entry of obj.results) {
    if (!isSearchResultEntry(entry)) return false;
  }
  if (obj.nextCursor !== undefined && typeof obj.nextCursor !== 'string') {
    return false;
  }
  return true;
}

function isSearchResultEntry(v: unknown): v is SearchResultEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as {
    artifactId?: unknown;
    latestVersion?: unknown;
    kind?: unknown;
    description?: unknown;
    tags?: unknown;
    publishedAt?: unknown;
  };
  if (typeof o.artifactId !== 'string') return false;
  if (typeof o.latestVersion !== 'string') return false;
  if (o.kind !== 'gadget' && o.kind !== 'blueprint') return false;
  if (typeof o.publishedAt !== 'string') return false;
  if (o.description !== undefined && typeof o.description !== 'string') {
    return false;
  }
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags)) return false;
    for (const t of o.tags) {
      if (typeof t !== 'string') return false;
    }
  }
  return true;
}

function isSearchErrorBody(v: unknown): v is SearchErrorBody {
  if (v === null || typeof v !== 'object') return false;
  const o = v as { error?: unknown; message?: unknown };
  if (typeof o.error !== 'string' || typeof o.message !== 'string') return false;
  return (SEARCH_ERROR_CODES as readonly string[]).includes(o.error);
}

/* -------------------------------------------------------------------------- */
/* Human-readable rendering                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Render the default human-readable view. Each entry takes two lines:
 *
 *   gadget @my-org/weather-card@0.1.0 — Beautiful weather card
 *     install: ggui install @my-org/weather-card@0.1.0 --registry=registry.example.com
 *
 * The `install:` hint inlines the registry hostname so operators can
 * copy-paste without re-deriving it. If `nextCursor` is present, a
 * pagination hint follows the entry list.
 */
function renderHumanLines(
  body: SearchResponse,
  registryUrl: string,
): readonly string[] {
  const out: string[] = [];
  const host = hostnameOf(registryUrl);
  for (const entry of body.results) {
    const desc = entry.description !== undefined ? ` — ${entry.description}` : '';
    out.push(`${entry.kind} ${entry.artifactId}@${entry.latestVersion}${desc}`);
    // Mirror the install verb against the entry's kind so the hint
    // points operators at `ggui blueprint install` for blueprint rows,
    // `ggui gadget install` for gadget rows.
    out.push(
      `  install: ggui ${entry.kind} install ${entry.artifactId}@${entry.latestVersion} --registry=${host}`,
    );
  }
  if (body.nextCursor !== undefined) {
    out.push(`… (more: rerun with --cursor=${body.nextCursor})`);
  }
  return out;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* -------------------------------------------------------------------------- */
/* Help text                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build verb-specific help text. Takes the `kind` so the rendered
 * lines say `ggui gadget search` / `ggui blueprint search` and the
 * filter list omits gadget-only options on the blueprint surface.
 */
export function buildSearchHelp(kind: ArtifactKind): string {
  const verb = `ggui ${kind} search`;
  const hookLines =
    kind === 'gadget'
      ? `  --hook <name>             Filter gadgets by exported hook name
                            (e.g. \`--hook useMap\`).
`
      : '';
  return `${verb} — query the marketplace registry for ${kind}s

Usage:
  ${verb} [q] [options]

Arguments:
  [q]                       Optional full-text query. Matches against
                            ${kind} name, description, and tags.

Options:
${hookLines}  --tag <tag>               Filter by tag (exact match).
  --author <id>             Filter by author (caller id or substring
                            of authorName).
  --limit <n>               Page size; 1..200, default 50.
  --cursor <opaque>         Opaque cursor from a previous response —
                            roundtrip verbatim for pagination.
  --registry <url>          Override the registry URL. Three-layer
                            resolution: flag > GGUI_REGISTRY env >
                            ggui.json#registry > error if unset.
  --json                    Emit the raw JSON response body instead of
                            the human-readable table.
  --help, -h                Show this help.

Examples:
  ${verb}                                  # all ${kind}s, default page
  ${verb} weather                          # full-text on name+description+tags
  ${verb} --tag map --author @my-org
  ${verb} --registry https://registry.example.com
  ${verb} --limit 100 --cursor <opaque>
  ${verb} --json
`;
}
