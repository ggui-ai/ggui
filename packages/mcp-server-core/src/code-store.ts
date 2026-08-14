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
 * - {@link CodeStore.delete} MUST be idempotent — an absent hash
 *   (never stored, or already removed) resolves rather than throws.
 *   Stores that actually remove content MUST make {@link CodeStore.get}
 *   return `null` for that hash afterwards; a deployment that keeps
 *   every bundle MAY implement it as a no-op.
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
 *   without `codeUrl`. Nothing catches the response: a bootstrap
 *   mounts on `codeUrl`, on a system-card `kind`, or on the live trio
 *   (`wsUrl` + `wsToken`), and a compiled-component render can only
 *   ever use the first or the third. So what survives is the live
 *   trio when the deployment mints one, and otherwise a bootstrap
 *   with no mount mode at all. Because that difference is invisible
 *   on the wire, a producer that proceeds MUST make the failure
 *   observable — the reference producer emits
 *   `render_code_write_failed` rather than swallowing it.
 * - On `get` failure for an existing hash, the route returns 500. The
 *   iframe runtime's static seed-fetch throws, and the boot outcome
 *   depends on the same trio: with it, the runtime warns and lets the
 *   live channel deliver the render; without it, the failure is
 *   terminal and surfaces as `UI_INITIALIZE_FAILED`.
 * - Missing hash on the read path (`get` returns `null`) is 404 — a
 *   normal outcome (server restart with in-memory store, expired
 *   filesystem cache, etc.). The runtime treats it exactly like the
 *   500 above: live trio ⇒ degraded boot, no live trio ⇒ terminal.
 * - A removed hash reads exactly like one that was never stored: `get`
 *   returns `null`, the route 404s. `delete` therefore has no distinct
 *   read-side failure mode, and callers cannot tell removal from a
 *   cold store — which is why removal is an operator action, never a
 *   render-path one.
 *
 * **Observable violation:**
 * - Contract test `runCodeStoreConformance(label, factory)`
 *   (`@ggui-ai/mcp-server-core/contract-tests`) covers every
 *   obligation above: round-trip preserves bytes; idempotent
 *   put-twice; missing returns null; hashOf is deterministic +
 *   matches sha256(code); delete-then-get misses, double-delete
 *   resolves, and delete leaves sibling hashes intact. Every
 *   implementation runs it — impl-specific behavior (on-disk layout,
 *   malformed-hash rejection) stays in the impl's own suite.
 * - Route-level: `code-route.test.ts` (`@ggui-ai/mcp-server`) asserts
 *   404 on a hash that was never `put` and 400 on a malformed one.
 * - Producer-side: the put-failure obligation above is pinned by the
 *   code-delivery suite in `render.test.ts`
 *   (`@ggui-ai/mcp-server-handlers`) — a rejecting store leaves the
 *   render succeeding, emits the named event, and stamps the
 *   live-channel posture on it. Scope worth stating plainly, since an
 *   unflagged gap reads as coverage: `runCodeStoreConformance` grades
 *   STORES, not producers, so that pin binds the reference producer
 *   in this repo. A third-party producer that swallows the rejection
 *   instead is caught by review, not by the kit.
 *
 * ## Reference implementations
 *
 * - {@link InMemoryCodeStore} (`mcp-server-core/in-memory/code-store`):
 *   process-local Map. Tests + ephemeral deployments — every codeUrl
 *   minted before a restart 404s after it, so a host holding an old
 *   bootstrap re-resolves the render (which re-mints against the fresh
 *   store) or falls back to the live channel.
 * - `FileSystemCodeStore` (`@ggui-ai/mcp-server`): node:fs-backed,
 *   default root `~/.ggui/code-cache/`. Survives `ggui serve` restart
 *   so claude.ai's iframe cache still resolves the URL after a kick.
 * - Hosted cloud uses S3 + CloudFront — the OSS interface is shape-
 *   compatible; a closed adapter implements it in the hosted runtime.
 *
 * ## Out of scope (deliberate)
 *
 * - Eviction *policy*. {@link CodeStore.delete} is the removal
 *   primitive, but nothing in the seam decides what to remove or when
 *   — no LRU, no TTL, no size cap. The filesystem impl grows unbounded
 *   until someone acts; operators can also `rm -rf` the cache root any
 *   time (the `Cache-Control: immutable` contract means stale URLs are
 *   NEVER revalidated, only re-fetched, so a missing cached file just
 *   rerenders the upstream once).
 * - Range reads / streaming. componentCode is small; whole-blob is fine.
 * - Compression. node serves with content-encoding identity; if
 *   operators care, a CDN in front of the route handles it transparently.
 */
import { createHash } from "node:crypto";

/**
 * Content-addressable code blob storage. Key = `sha256(code)` hex, value
 * = a content-addressable code blob — compiled JavaScript module text
 * the iframe runtime mounts, or an authored (pre-compile) source body
 * kept for blueprint provenance (`Blueprint.sourceCodeHash`, guuey#179
 * finding #4). Both share the same content-hash-keyed, immutable-body
 * shape; this store doesn't distinguish them by kind.
 */
export interface CodeStore {
  /**
   * Whether records written through this store survive a process
   * restart. The substrate gate treats anything not `'durable'` as
   * unbound: the wire must never promise restorability an
   * implementation cannot keep (#457 — NOT_SUPPORTED derives from
   * DECLARED durability, not from mere binding).
   */
  readonly durability: 'durable' | 'ephemeral';

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
   * Remove a stored bundle. Deployments that never remove content may
   * implement this as a no-op.
   *
   * Idempotent — a hash that was never stored, or was already removed,
   * MUST resolve rather than throw. Implementations that do remove
   * MUST make {@link CodeStore.get} return `null` for the hash
   * afterwards, and MUST leave every other hash untouched.
   *
   * Malformed hashes are not an error either: an implementation that
   * derives a storage path from the hash MUST reject the key before
   * touching storage (the same narrowing {@link CODE_HASH_REGEX}
   * gives the read path) and resolve, so a bad key can never remove
   * something outside the store.
   */
  delete(hash: string): Promise<void>;

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
