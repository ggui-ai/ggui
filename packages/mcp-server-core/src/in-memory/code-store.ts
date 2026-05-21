/**
 * InMemoryCodeStore — reference {@link CodeStore} for tests + ephemeral
 * OSS (no-disk-touch dev mode).
 *
 * Backing store is one `Map<hash, code>`. No size cap, no eviction —
 * test runs are short-lived; OSS dev runs replace the process when the
 * operator restarts and the inline-componentCode fallback covers any
 * URL that the (rebooted, empty) store can't resolve.
 *
 * Persistent OSS dev should bind {@link FileSystemCodeStore} from
 * `@ggui-ai/mcp-server`; production hosted runs use the S3-backed
 * adapter in a closed adapter package.
 */
import {
  CODE_HASH_REGEX,
  sha256Hex,
  type CodeStore,
} from '../code-store.js';

export class InMemoryCodeStore implements CodeStore {
  private readonly store = new Map<string, string>();

  async put(hash: string, code: string): Promise<void> {
    if (!CODE_HASH_REGEX.test(hash)) {
      throw new Error(
        `InMemoryCodeStore.put: hash must match ${CODE_HASH_REGEX.source}, got ${JSON.stringify(hash)}`,
      );
    }
    // Idempotent — same (hash, code) pair is a no-op. Different code
    // for the same hash is impossible by construction (sha256 collision)
    // but if a misbehaving caller passes a wrong hash, last-write-wins
    // is acceptable; the route lookup will still return SOME bytes.
    this.store.set(hash, code);
  }

  async get(hash: string): Promise<string | null> {
    return this.store.get(hash) ?? null;
  }

  hashOf(code: string): string {
    return sha256Hex(code);
  }

  /** Live entry count. Useful for tests + introspection. */
  get size(): number {
    return this.store.size;
  }
}
