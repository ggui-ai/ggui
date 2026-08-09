/**
 * Shared registry-URL resolution for every CLI verb that talks to a
 * marketplace registry (`gadget`/`blueprint` `publish` / `install` /
 * `search`, `keys register`).
 *
 * One precedence chain for every verb (npm model — highest wins):
 *
 *   1. `--registry <url>` flag
 *   2. `GGUI_REGISTRY` env var
 *   3. `ggui.json#registry` — the nearest ggui.json that CARRIES the
 *      field, walking up from cwd (see {@link findRegistryField}).
 *
 * Verbs differ only in what happens on a full miss:
 *
 *   - **READ verbs** (install, search) pass {@link DEFAULT_REGISTRY_URL}
 *     as `defaultUrl` and fall back to the public registry — a consumer
 *     with zero config can still search + install, exactly like `npm
 *     install` reaching registry.npmjs.org.
 *   - **WRITE verbs** (publish, keys register) omit `defaultUrl` and get
 *     a `no-registry` error — operators must opt into a publish target
 *     explicitly so a typo can't push to an unintended registry.
 *
 * This module is the ONLY place the chain is implemented. Per-verb
 * copies drifted once (install put `ggui.json` ahead of the env var
 * while publish/search did the reverse); a single resolver makes that
 * class of drift impossible. File IO rides the shared `./ggui-json.ts`
 * helpers (`readGguiJson` + the `FIND_MAX_DEPTH` walk budget) — only
 * the registry-field narrowing lives here.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  FIND_MAX_DEPTH,
  GGUI_JSON_FILENAME,
  readGguiJson,
} from './ggui-json.js';

/**
 * Fallback registry for READ verbs when no explicit config is present:
 * the public ggui marketplace registry (the same role
 * registry.npmjs.org plays for npm). Point `--registry` /
 * `GGUI_REGISTRY` / `ggui.json#registry` at your own registry to
 * override it — self-hosted registries are first-class (see
 * `@ggui-ai/registry-server`).
 */
export const DEFAULT_REGISTRY_URL = 'https://registry.ggui.ai';

/** Which layer of the chain produced the URL. Surfaced in publish's
 * `registry: <url> (<source>)` status line. */
export type RegistryUrlSource = 'flag' | 'env' | 'ggui.json' | 'default';

export type RegistryUrlResolution =
  | {
      readonly ok: true;
      readonly url: string;
      readonly source: RegistryUrlSource;
    }
  | {
      readonly ok: false;
      /** `no-registry` = nothing configured and no default supplied;
       * `invalid-registry` = something WAS configured but is not a
       * usable http(s) URL (or a ggui.json on the walk is unreadable). */
      readonly code: 'no-registry' | 'invalid-registry';
      /** Operator-facing diagnostic, safe to write to stderr verbatim. */
      readonly message: string;
    };

export interface ResolveRegistryUrlOptions {
  /** `--registry <url>` flag value — highest precedence. */
  readonly flag?: string;
  /** Directory the `ggui.json` walk starts from. */
  readonly cwd: string;
  /** Environment view — injectable for tests. */
  readonly env: { readonly GGUI_REGISTRY?: string | undefined };
  /**
   * Fallback when the whole chain misses. READ verbs pass
   * {@link DEFAULT_REGISTRY_URL}; WRITE verbs omit it and receive a
   * `no-registry` error instead.
   */
  readonly defaultUrl?: string;
}

/**
 * Resolve the registry URL for a verb. Pure lookup + validation — no
 * network. Returned URLs are normalized (trailing slashes stripped) so
 * callers can append routes (`/search`, `/pkg/…`, `/publish`)
 * deterministically.
 */
export function resolveRegistryUrl(
  opts: ResolveRegistryUrlOptions,
): RegistryUrlResolution {
  if (opts.flag !== undefined && opts.flag.length > 0) {
    return validateUrl(
      opts.flag,
      'flag',
      `--registry value is not a valid URL: ${opts.flag}`,
    );
  }
  const envValue = opts.env.GGUI_REGISTRY;
  if (typeof envValue === 'string' && envValue.length > 0) {
    return validateUrl(
      envValue,
      'env',
      `GGUI_REGISTRY is not a valid URL: ${envValue}`,
    );
  }
  const field = findRegistryField(opts.cwd);
  if (field.hit === 'error') {
    return { ok: false, code: 'invalid-registry', message: field.message };
  }
  if (field.hit === 'found') {
    return validateUrl(
      field.registry,
      'ggui.json',
      `ggui.json#registry at ${field.path} is not a valid URL: ${field.registry}`,
    );
  }
  if (opts.defaultUrl !== undefined) {
    return validateUrl(
      opts.defaultUrl,
      'default',
      `default registry URL is not a valid URL: ${opts.defaultUrl}`,
    );
  }
  return {
    ok: false,
    code: 'no-registry',
    message:
      'no registry resolved. Set one of:\n' +
      '  --registry <url>\n' +
      '  GGUI_REGISTRY env var\n' +
      '  "registry": "<url>" in the nearest ggui.json',
  };
}

type RegistryFieldSearch =
  | { readonly hit: 'found'; readonly registry: string; readonly path: string }
  | { readonly hit: 'none' }
  | { readonly hit: 'error'; readonly message: string };

/**
 * Field-seeking walk: climb up to {@link FIND_MAX_DEPTH} parent
 * directories looking for the nearest `ggui.json` that CARRIES a
 * usable `registry` field.
 *
 * Deliberately NOT `findGguiJson` (nearest FILE wins): a nested
 * project's field-less ggui.json must not shadow a monorepo root that
 * pins the registry — stopping at the first file would silently route
 * READ verbs to the public default past the operator's config.
 *
 * Tolerance rules per file on the walk:
 *   - absent / empty / non-string `registry` → keep walking. The file
 *     is valid, just silent on this question; an ancestor may answer.
 *   - unreadable / unparseable ggui.json → hard error. Silently
 *     walking past a corrupt config could reroute a read to the
 *     public default when the operator's (unparseable) file named
 *     their own registry.
 *
 * Reads ride `readGguiJson` (shared IO + structural validation); this
 * function adds only the field narrowing.
 */
function findRegistryField(startDir: string): RegistryFieldSearch {
  let dir = resolve(startDir);
  for (let i = 0; i <= FIND_MAX_DEPTH; i++) {
    const candidate = join(dir, GGUI_JSON_FILENAME);
    if (existsSync(candidate)) {
      const loaded = readGguiJson(candidate);
      if ('error' in loaded) {
        return { hit: 'error', message: loaded.error };
      }
      const registry = loaded.value['registry'];
      if (typeof registry === 'string' && registry.length > 0) {
        return { hit: 'found', registry, path: candidate };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return { hit: 'none' };
    dir = parent;
  }
  return { hit: 'none' };
}

/** Parse + validate an http(s) URL and strip trailing slashes. */
function validateUrl(
  raw: string,
  source: RegistryUrlSource,
  invalidMessage: string,
): RegistryUrlResolution {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid-registry', message: invalidMessage };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'invalid-registry',
      message: `${invalidMessage} (must be http or https)`,
    };
  }
  let serialized = parsed.toString();
  while (serialized.endsWith('/')) serialized = serialized.slice(0, -1);
  return { ok: true, url: serialized, source };
}
