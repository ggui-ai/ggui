/**
 * CodeStore — content-addressable storage for compiled componentCode.
 *
 * ## Why this seam exists
 *
 * Compiled componentCode historically rode three different channels —
 * base64 inlined under `_meta.ggui.bootstrap.componentCode` (now
 * retired), templated into the per-render shell HTML, and (briefly)
 * over the WebSocket. Each was misshapen for the data:
 * `_meta` bloated every tool-result envelope and depended on hosts that
 * may strip custom meta; templated shells precluded cross-render
 * dedup; WS frames hit size limits and tied initial mount to the WS
 * handshake. As of T3-1, the inline base64 channel is gone; the
 * content-addressable URL channel below is the sole delivery surface.
 *
 * componentCode has four properties that argue for one channel:
 *   1. Immutable per generation — never mutates after produced.
 *   2. Content-addressable — `sha256(code)` is a stable id that
 *      naturally dedups across renders and users.
 *   3. Independent lifecycle from render state — code outlives the
 *      render that produced it.
 *   4. Variable size 100B–50KB — too big for `_meta` inlining, too small
 *      for streaming.
 *
 * These properties match HTTP + caching primitives: serve at
 * `GET /code/<hash>.js` with `Cache-Control: public, max-age=31536000,
 * immutable`. Hosted cloud already converged on this with S3 +
 * CloudFront; OSS adopts the same wire format with a different storage
 * adapter so consumers (iframe runtime, render handler) cannot tell the
 * difference between OSS and hosted.
 *
 * ## Protocol & Contract Bar
 *
 * **Parties:**
 * - Producer / writer: `mcp-server-handlers/renders/render.ts` —
 *   after `runGenerationIntoGguiSession` produces componentCode, the handler
 *   computes `sha256(code)` and `put`s the (hash, code) pair before
 *   minting the bootstrap envelope.
 * - Consumer / reader: the HTTP route `GET /code/<hash>.js` mounted by
 *   `@ggui-ai/mcp-server`. Iframe runtimes fetch via this route; the
 *   route MUST treat unknown hashes as 404 and reject malformed hashes
 *   with 400.
 *
 * **Obligations:**
 * - {@link CodeStore.put} MUST be idempotent — the hash is the key, and
 *   the value is by construction `sha256(code)`-derived. Multiple writes
 *   of the same `(hash, code)` pair are no-ops; the store MUST NOT
 *   error or rewrite.
 * - {@link CodeStore.get} MUST return the exact bytes that were
 *   `put`. No transformation (compression, transpilation) on read.
 * - {@link CodeStore.get} on a missing hash MUST return `null`.
 *   Throwing for missing-hash is a contract violation.
 * - Underlying errors (filesystem IO, network, S3 5xx) MUST throw —
 *   callers decide retry policy.
 * - Hashes MUST match `[a-f0-9]{64}` (full sha256 hex) when emitted by
 *   {@link hashOf}; the route validator narrows to this charset to
 *   prevent path-traversal attacks. Implementations MAY accept shorter
 *   prefixes for storage efficiency only when safe path encoding is
 *   guaranteed (filesystem impl uses two-level directory sharding from
 *   the full hash).
 *
 * **Failure mode:**
 * - On `put` failure (disk full, S3 5xx), the producer MAY proceed
 *   without `codeUrl` — the response falls back to inline base64
 *   `componentCode`.
 * - On `get` failure for an existing hash, the route returns 500;
 *   iframe runtime surfaces a `BUNDLE_FETCH_FAILED` boot failure.
 * - Missing hash on the read path (`get` returns `null`) is 404 — a
 *   normal outcome (server restart with in-memory store, expired
 *   filesystem cache, etc.); the iframe runtime falls back to
 *   inline `componentCode` if the bootstrap carries one.
 *
 * **Observable violation:**
 * - Contract test `codeStoreContract(impl)` covers: round-trip preserves
 *   bytes; idempotent put-twice; missing returns null; hashOf is
 *   deterministic + matches sha256(code); the route 404s on a hash that
 *   was never `put`.
 *
 * ## Reference implementations
 *
 * - {@link InMemoryCodeStore} (`mcp-server-core/in-memory/code-store`):
 *   process-local Map. Tests + ephemeral OSS (the codeUrl is invalid
 *   after restart, but the inline-componentCode fallback covers that).
 * - `FileSystemCodeStore` (`@ggui-ai/mcp-server`): node:fs-backed,
 *   default root `~/.ggui/code-cache/`. Survives `ggui serve` restart
 *   so claude.ai's iframe cache still resolves the URL after a kick.
 * - Hosted cloud uses S3 + CloudFront — the OSS interface is shape-
 *   compatible; a closed adapter implements it in the hosted runtime.
 *
 * ## Out of scope (deliberate)
 *
 * - Eviction. Filesystem impl grows unbounded; operators can `rm -rf`
 *   the cache root any time (the `Cache-Control: immutable` contract
 *   means stale URLs are NEVER revalidated, only re-fetched, so a
 *   missing cached file just rerenders the upstream once).
 * - Range reads / streaming. componentCode is small; whole-blob is fine.
 * - Compression. node serves with content-encoding identity; if
 *   operators care, a CDN in front of the route handles it transparently.
 */
import { createHash } from "node:crypto";

/**
 * Content-addressable code blob storage. Key = `sha256(code)` hex, value
 * = the compiled JavaScript module text the iframe runtime mounts.
 */
export interface CodeStore {
  /**
   * Persist `code` under `hash`. Idempotent — multiple writes of the
   * same `(hash, code)` pair are no-ops.
   *
   * Implementations MUST NOT verify that `hash === sha256(code)` — the
   * caller owns that derivation via {@link CodeStore.hashOf} (or the
   * default {@link sha256Hex} helper). Verification on every put would
   * double the work for no security gain: the only reader is the same
   * trust boundary as the writer (the server itself).
   */
  put(hash: string, code: string): Promise<void>;

  /**
   * Fetch `code` by hash. Returns `null` when absent. MUST return the
   * exact UTF-8 string that was `put`. No transformation.
   */
  get(hash: string): Promise<string | null>;

  /**
   * Compute the canonical hash for `code`. Defaults to
   * `sha256(code).hex` — every reference impl SHOULD delegate to
   * {@link sha256Hex} so cross-impl writes hit the same key.
   */
  hashOf(code: string): string;
}

/**
 * Default hash derivation. SHA-256 hex over UTF-8 bytes of `code`.
 *
 * Exported separately so the render handler can compute the hash without
 * holding a {@link CodeStore} reference (e.g. when emitting the URL
 * onto a tool result before the put has completed).
 */
export function sha256Hex(code: string): string {
  return createHash("sha256").update(code, "utf-8").digest("hex");
}

/**
 * Strict regex for a full sha256 hex hash. The `/code/:hash.js` route
 * uses this to reject malformed hashes (path-traversal defense — without
 * narrowing, `:hash` could contain `..` or `/`).
 */
export const CODE_HASH_REGEX = /^[a-f0-9]{64}$/;
