/**
 * Minimal ggui.json read/write helpers shared by gadget subcommands.
 *
 * Shared by the publish and install subcommands so neither has to
 * duplicate the path-walk + JSON IO scaffolding. The parser is
 * deliberately structural (no schema parse): install touches
 * `app.gadgets` only, so a malformed `theme` block elsewhere in the
 * file shouldn't prevent an install from rewriting the array.
 *
 * The shape returned is the raw decoded JSON. Callers narrow the
 * sub-objects they touch (e.g. `app.gadgets`) and run the
 * full schema parser themselves if they want round-trip validation —
 * keeps this helper minimal + zero-dep against `@ggui-ai/project-config`.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Canonical filename — duplicated from `@ggui-ai/project-config` so
 * this helper stays free of that dependency. The constant lives in one
 * place per package; updates ride along on a project-config bump. */
export const GGUI_JSON_FILENAME = 'ggui.json';

/** How many parent directories to walk before giving up. Mirrors the
 * convention used by `gadget-search.ts#findGguiJson` + the upstream
 * `@ggui-ai/project-config/node` helper. */
export const FIND_MAX_DEPTH = 8;

/**
 * Walk up from `startDir` looking for the first `ggui.json` ancestor.
 * Returns the absolute path or `null` if none found within
 * {@link FIND_MAX_DEPTH} parent directories.
 *
 * Mirrors the algorithm in `@ggui-ai/project-config/node`'s
 * `findGguiJson`. Duplicated here (rather than imported) so the
 * publish/install/search subcommands don't pull the full project-config
 * dependency tree — the boundary justification matches the existing
 * `gadget-search.ts` rationale.
 */
export function findGguiJson(startDir: string): string | null {
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
 * Object shape of a successfully-decoded ggui.json. Always a plain
 * JSON object at the root — arrays / scalars / null are rejected by
 * the schema-side parser at boot, but this helper is structural so we
 * narrow to "object-or-die" explicitly.
 */
export type GguiJsonObject = { [key: string]: unknown };

/**
 * Read + structurally validate a ggui.json file from a known path.
 * Returns the decoded JSON object on success or a descriptive error
 * string. The shape is left as `GguiJsonObject` (string-keyed unknown)
 * because callers walk the tree by path; running the full
 * `@ggui-ai/project-config` parser here would couple gadget-install
 * to the entire manifest's schema posture.
 */
export function readGguiJson(
  path: string,
): { value: GguiJsonObject } | { error: string } {
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
  return { value: decoded as GguiJsonObject };
}

/**
 * Write a decoded ggui.json back to disk. Preserves a 2-space indent
 * with a trailing newline — matches the formatting `prettier` would
 * apply, so the gadget-install diff stays minimal in operator repos
 * that run prettier on commit. We do NOT round-trip JSON5 / comments
 * (ggui.json is plain JSON per `@ggui-ai/project-config`); any
 * pre-existing comments would have failed the original `JSON.parse`
 * already.
 */
export function writeGguiJson(path: string, value: GguiJsonObject): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
