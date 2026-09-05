/**
 * Content-hash naming for the iframe-runtime bundle URL (#472).
 *
 * ONE derivation, three consumers:
 *
 *   - `createGguiServer` (server.ts) hashes the captured bundle bytes,
 *     mounts the immutable twin route, and rewrites the stamped
 *     `runtimeUrl` — see the "Content-hashed runtime URL" block there.
 *   - `mountRuntimeBundleRoute` serves the hashed name it is handed.
 *   - Deployments that compose their own render handler (bypassing the
 *     factory's default handler set) mint an absolute `runtimeUrl`
 *     themselves; {@link resolveHashedRuntimeBundleUrl} lets them stamp
 *     the SAME hashed name the co-resident factory mounts, instead of
 *     re-deriving the scheme by hand and drifting.
 *
 * The scheme: `sha256(bytes)` truncated to 12 hex chars, inserted
 * before the filename's extension — `iframe-runtime.js` →
 * `iframe-runtime.<hash>.js`. 12 chars (48 bits) is plenty for
 * cache-busting across deploys; this is not an integrity check (SRI
 * would be a separate, full-length hash).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { RUNTIME_BUNDLE_FILE, RUNTIME_BUNDLE_URL_PATH } from "@ggui-ai/iframe-runtime/server";

/** Truncated content hash used in the bundle's immutable URL name. */
export function computeRuntimeBundleHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/**
 * Insert `hash` into `urlOrPath`'s filename, but ONLY when that
 * filename is exactly `plainName` — a URL pointing at a foreign copy
 * of the bundle (different name) is returned untouched, because the
 * foreign host serves only the name the operator configured. Applies
 * to both bare paths (`/_ggui/iframe-runtime.js`) and absolute URLs
 * (`https://cdn.example.com/_ggui/iframe-runtime.js`).
 */
export function insertRuntimeBundleHash(
  urlOrPath: string,
  hash: string,
  plainName: string
): string {
  const dot = plainName.lastIndexOf(".");
  const hashedName =
    dot === -1
      ? `${plainName}.${hash}`
      : `${plainName.slice(0, dot)}.${hash}${plainName.slice(dot)}`;
  if (!urlOrPath.endsWith(`/${plainName}`) && urlOrPath !== plainName) return urlOrPath;
  return `${urlOrPath.slice(0, urlOrPath.length - plainName.length)}${hashedName}`;
}

/**
 * Rewrite `plainUrl` (an absolute URL or path ending in the default
 * bundle filename) to its content-hashed twin, hashing the bundle at
 * `bundleFile` (default: the workspace's built bundle — the same file
 * `createGguiServer` serves, so both stamp the same name). Falls back
 * to `plainUrl` unchanged when the bundle is unreadable — the plain
 * `no-cache` route always exists, so the fallback stays correct, just
 * revalidated.
 */
export function resolveHashedRuntimeBundleUrl(
  plainUrl: string,
  bundleFile: string = RUNTIME_BUNDLE_FILE
): string {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(bundleFile);
  } catch {
    // Bundle not built / not shipped — mint the plain revalidated name.
    return plainUrl;
  }
  const plainName = RUNTIME_BUNDLE_URL_PATH.slice(
    RUNTIME_BUNDLE_URL_PATH.lastIndexOf("/") + 1
  );
  return insertRuntimeBundleHash(plainUrl, computeRuntimeBundleHash(bytes), plainName);
}

/**
 * The 12-hex runtime-bundle content hash for the bundle at
 * `bundleFile` (default: the workspace's built bundle — the same file
 * `createGguiServer` hashes, so both derive the same value), or
 * `undefined` when the bundle is unreadable. Deployments that compose
 * their own render handler (a production deployment's `handlers:` shape)
 * use this to build a `createCodeModuleUrlMinter` that stamps the SAME
 * `<rt>` the co-resident factory's variant route serves (ggui#522
 * slice 2) — re-deriving the scheme by hand is how the codeUrl binding
 * drifted in slice 1.
 */
export function resolveRuntimeBundleHash(
  bundleFile: string = RUNTIME_BUNDLE_FILE
): string | undefined {
  try {
    return computeRuntimeBundleHash(fs.readFileSync(bundleFile));
  } catch {
    return undefined;
  }
}
