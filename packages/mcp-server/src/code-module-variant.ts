/**
 * Strict-CSP module-variant delivery (ggui#522 slice 2).
 *
 * The `/code/<hash>.js` route serves STORED component bytes — compiled
 * ESM whose imports are still BARE specifiers (`react`,
 * `@ggui-ai/design/primitives`, …). A browser cannot import that
 * standalone; the renderer historically bridged the gap in-frame by
 * rewriting bare specifiers to `data:` shims and instantiating the
 * module from a `blob:` URL — both of which a strict host CSP refuses.
 *
 * This module adds the server-side twin of that bridge: a SECOND,
 * immutable route `/code/<hash>.m<rt>.js` serving the SAME stored bytes
 * with the rewrite already applied — every bare specifier resolved to a
 * static shim asset under `/_ggui/shims/<rt>/<name>.js` on the same
 * origin. A frame whose `script-src` allows only the asset origin can
 * `import()` the variant URL directly: no `blob:`, no `data:`, no
 * `'unsafe-eval'`.
 *
 * `<rt>` — the 12-hex content hash of the runtime bundle — is the
 * variant KEY, and it lives in the PATH deliberately: the asset CDN
 * (CloudFront `CACHING_OPTIMIZED`) ignores query strings, so a
 * query-keyed variant would collapse to one cached body across
 * runtime versions. The hash versions the whole family: the shim
 * files ship in the runtime bundle's dist, so any shim-affecting
 * change also changes the bundle bytes, which changes `<rt>`, which
 * changes every variant URL — immutable caching stays sound.
 *
 * The route serves only the CURRENT `<rt>`: after a redeploy, a
 * CDN-evicted old-variant URL 404s (`no-store`) and the renderer falls
 * back to its raw-bytes ladder — honest degradation, never stale shims.
 *
 * 3rd-party gadget packages (GG.8.2) have no static shim (their
 * exports are derived per-render from the generated code); a module
 * importing one is NOT asset-deliverable. Both ends respect that: the
 * minter declines to stamp `codeModuleUrl`, and the route declines
 * (404) any body whose rewrite leaves a bare specifier standing.
 */

import type { Express, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  rewriteImports,
  findBareImportSpecifiers,
  stripMarkers,
  ASSET_SHIM_FOR_SPECIFIER,
} from "@ggui-ai/design/rendering";
import { hoistImports } from "@ggui-ai/design/module-loader";
import type { Logger } from "./logger.js";

/**
 * Mint the `codeModuleUrl` for one render's component code, or decline.
 *
 * `undefined` ⇒ the code is not asset-deliverable (it imports a
 * package with no static shim) — the slice then carries only the raw
 * `codeUrl`/`codeB64` carriers and the renderer uses its blob ladder.
 */
export type MintCodeModuleUrl = (args: {
  /** RAW stored component code (markers included — stripped here). */
  readonly code: string;
  /** `sha256(code)` — the same hash `codeUrl` is composed from. */
  readonly hash: string;
  /** Code base URL, no trailing slash (the emitter already trims). */
  readonly base: string;
}) => string | undefined;

/** The variant URL for (hash, rt) under `base` — ONE composition site. */
export function composeCodeModuleUrl(args: {
  readonly base: string;
  readonly hash: string;
  readonly runtimeHash: string;
}): string {
  return `${args.base}/code/${args.hash}.m${args.runtimeHash}.js`;
}

/**
 * Build the minter every `codeUrl` emitter injects. Coverability is
 * decided from the code's own import list: every bare specifier must
 * have a static shim ({@link ASSET_SHIM_FOR_SPECIFIER}) or the mint
 * declines. Markers are stripped first — their embedded JSON can
 * contain strings the import scanner would misread.
 */
export function createCodeModuleUrlMinter(args: {
  readonly runtimeHash: string;
}): MintCodeModuleUrl {
  const { runtimeHash } = args;
  return ({ code, hash, base }) => {
    const bare = findBareImportSpecifiers(stripMarkers(code));
    if (!bare.every((spec) => spec in ASSET_SHIM_FOR_SPECIFIER)) {
      return undefined;
    }
    return composeCodeModuleUrl({ base, hash, runtimeHash });
  };
}

/**
 * Rewrite stored component bytes into the servable asset-module
 * variant — the same preprocessing the renderer's blob ladder applies
 * (strip markers, hoist imports) plus the `asset-url` specifier
 * rewrite. Declines when any bare specifier survives (no static shim
 * exists for it) instead of serving a module that fails at eval.
 */
export function rewriteToAssetModule(args: {
  readonly code: string;
  readonly shimBaseUrl: string;
}): { readonly ok: true; readonly code: string } | { readonly ok: false; readonly leftover: readonly string[] } {
  const rewritten = rewriteImports(hoistImports(stripMarkers(args.code)), {
    mode: "asset-url",
    shimBaseUrl: args.shimBaseUrl,
  });
  const leftover = findBareImportSpecifiers(rewritten);
  if (leftover.length > 0) return { ok: false, leftover };
  return { ok: true, code: rewritten };
}

/**
 * Read the static shim files emitted by the iframe-runtime build
 * (`dist/shims/<name>.js`) into memory, keyed by file name. Captured
 * ONCE at composition — the immutable shim route must keep serving the
 * exact bytes its URL family was stamped for, even across an in-place
 * rebuild of the dist (same guarantee the hashed bundle route makes by
 * serving captured bytes).
 *
 * `undefined` when the directory is missing/empty (bundle built by an
 * older toolchain) — callers then skip the whole variant family.
 */
export function captureShimSources(
  shimsDir: string,
): ReadonlyMap<string, Buffer> | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(shimsDir);
  } catch {
    return undefined;
  }
  const out = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.endsWith(".js")) continue;
    try {
      out.set(entry, fs.readFileSync(path.join(shimsDir, entry)));
    } catch {
      // A vanishing file mid-capture degrades to "that shim 404s";
      // the renderer's fallback ladder covers it.
    }
  }
  return out.size > 0 ? out : undefined;
}

/** File-segment shape of a shim asset (`react.js`, `jsx-runtime.js`). */
const SHIM_FILE_REGEX = /^[a-z][a-z-]*\.js$/;

/** 12-hex runtime-hash path segment. */
const RUNTIME_HASH_REGEX = /^[a-f0-9]{12}$/;

/**
 * Mount `GET <urlPrefix>/:rt/:file` serving the captured shim sources
 * with the immutable posture of the hashed-bundle route. Only the
 * CURRENT `runtimeHash` is served; any other `rt` 404s `no-store` so a
 * stale URL can never lock wrong bytes into a cache.
 */
export function mountShimRoutes(opts: {
  readonly app: Express;
  readonly urlPrefix: string;
  readonly runtimeHash: string;
  readonly shims: ReadonlyMap<string, Buffer>;
}): void {
  const { app, urlPrefix, runtimeHash, shims } = opts;
  app.get(`${urlPrefix}/:rt/:file`, (req: Request, res: Response) => {
    // Same CORS rationale as the runtime bundle: module fetches from a
    // sandboxed `srcdoc` iframe (`null` origin) always run CORS mode.
    res.setHeader("Access-Control-Allow-Origin", "*");
    const rt = req.params["rt"];
    const file = req.params["file"];
    if (
      typeof rt !== "string" ||
      !RUNTIME_HASH_REGEX.test(rt) ||
      typeof file !== "string" ||
      !SHIM_FILE_REGEX.test(file)
    ) {
      res.setHeader("Cache-Control", "no-store");
      res.status(400).json({
        error: {
          code: "invalid_request",
          message: "shim path must be /<12-hex runtime hash>/<name>.js",
        },
      });
      return;
    }
    const source = rt === runtimeHash ? shims.get(file) : undefined;
    if (source === undefined) {
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({
        error: {
          code: "not_found",
          message:
            rt === runtimeHash
              ? "unknown shim module"
              : "shim family not served by this runtime build",
        },
      });
      return;
    }
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.status(200).send(source);
  });
}

/**
 * Options for the `/code/<hash>.m<rt>.js` variant route
 * (mounted by `mountCodeRoutes` BEFORE the plain routes).
 */
export interface CodeModuleVariantOptions {
  /** 12-hex content hash of the runtime bundle currently served. */
  readonly runtimeHash: string;
  /**
   * Absolute base of THIS build's shim directory
   * (`<codeBaseUrl><urlPrefix>/<runtimeHash>`), no trailing slash —
   * the rewrite embeds it into every import.
   */
  readonly shimBaseUrl: string;
}

/**
 * RegExp route for the variant path. A RegExp (not a string pattern)
 * on purpose: two params separated by literal dots inside one path
 * segment sit exactly on path-to-regexp's least-stable parsing ground,
 * and a silent non-match here would read as "variant never works".
 */
export const CODE_MODULE_VARIANT_ROUTE = /^\/code\/([a-f0-9]{64})\.m([a-f0-9]{12})\.js$/;

/**
 * Mount the module-variant route. Serving posture mirrors the plain
 * code route (immutable on success, `no-store` on every failure); the
 * two decline arms are:
 *
 *   - `rt` ≠ the current runtime hash → 404. The shims for another
 *     build are unknowable here; the renderer falls back to raw bytes.
 *   - leftover bare specifier after rewrite → 404. The module imports
 *     a package with no static shim (3rd-party gadget); serving it
 *     would fail at eval inside the frame instead of falling back.
 */
export function mountCodeModuleVariantRoute(opts: {
  readonly app: Express;
  readonly codeStore: import("@ggui-ai/mcp-server-core").CodeStore;
  readonly variant: CodeModuleVariantOptions;
  readonly logger: Logger;
}): void {
  const { app, codeStore, variant, logger } = opts;
  app.get(CODE_MODULE_VARIANT_ROUTE, async (req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    // RegExp routes surface capture groups as positional params.
    const hash = req.params["0"];
    const rt = req.params["1"];
    if (typeof hash !== "string" || typeof rt !== "string") {
      res.setHeader("Cache-Control", "no-store");
      res.status(400).json({
        error: { code: "invalid_request", message: "malformed variant path" },
      });
      return;
    }
    if (rt !== variant.runtimeHash) {
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({
        error: {
          code: "not_found",
          message: "variant family not served by this runtime build",
        },
      });
      return;
    }
    try {
      const code = await codeStore.get(hash);
      if (code === null) {
        res.setHeader("Cache-Control", "no-store");
        res.status(404).json({
          error: { code: "not_found", message: "unknown code hash" },
        });
        return;
      }
      const rewritten = rewriteToAssetModule({
        code,
        shimBaseUrl: variant.shimBaseUrl,
      });
      if (!rewritten.ok) {
        logger.warn("code_module_variant_declined", {
          hash,
          leftover: [...rewritten.leftover],
        });
        res.setHeader("Cache-Control", "no-store");
        res.status(404).json({
          error: {
            code: "not_found",
            message: "module not asset-deliverable (bare imports without static shims)",
          },
        });
        return;
      }
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.status(200).send(rewritten.code);
    } catch (err) {
      logger.warn("code_module_variant_failed", { hash, error: String(err) });
      res.setHeader("Cache-Control", "no-store");
      res.status(500).json({
        error: { code: "internal", message: "variant fetch failed" },
      });
    }
  });
}
