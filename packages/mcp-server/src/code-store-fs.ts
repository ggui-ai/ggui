/**
 * FileSystemCodeStore — node:fs-backed {@link CodeStore}. The OSS dev
 * default for `ggui serve`.
 *
 * Default root is `~/.ggui/code-cache/`; operators can override per
 * `createGguiServer({ codeStore })` for tests or project-local caches.
 *
 * ## Layout
 *
 * Two-level directory sharding by hash prefix to avoid stuffing one
 * directory with thousands of files:
 *
 *   <root>/<hash[0..2]>/<hash[2..]>.js
 *
 * e.g. `~/.ggui/code-cache/ab/cdef...0123.js`. The `.js` suffix isn't
 * load-bearing for retrieval — `get(hash)` is the only read API and it
 * derives the path from the hash — but operators occasionally `cat`
 * one for debugging, and the suffix tells their editor to syntax-
 * highlight as JavaScript.
 *
 * ## Atomicity
 *
 * `put` writes via temp-file + rename for atomic-or-throw — readers
 * never see a half-written file. The mkdir-recursive call before write
 * is idempotent and races safely (Linux `mkdir -p` semantics).
 *
 * ## Persistence + cleanup
 *
 * The store grows unbounded. Operators who care can periodically
 * `rm -rf ~/.ggui/code-cache/` — every entry is content-addressable
 * and immutable, so a re-fetch will repopulate from upstream code on
 * next push. There is no eviction policy in the seam itself.
 *
 * ## Permissions
 *
 * Files are written with default umask. The cache contains compiled
 * componentCode the agent generated; nothing more sensitive than what
 * already shipped over the wire to the iframe. Operators who need
 * tighter perms wrap with their own umask.
 */
import { createHash } from 'node:crypto';
import {
  access,
  constants as fsConstants,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CODE_HASH_REGEX,
  type CodeStore,
} from '@ggui-ai/mcp-server-core';

/** Options for {@link FileSystemCodeStore}. */
export interface FileSystemCodeStoreOptions {
  /**
   * Filesystem root for the cache. Defaults to `~/.ggui/code-cache/`.
   * Tests typically override to a project-local tmp dir.
   */
  readonly root?: string;
}

export class FileSystemCodeStore implements CodeStore {
  private readonly root: string;

  constructor(opts: FileSystemCodeStoreOptions = {}) {
    this.root = opts.root ?? join(homedir(), '.ggui', 'code-cache');
  }

  /** Absolute on-disk path for a given hash. Two-level sharded layout. */
  private absPath(hash: string): string {
    // Sharding: `<root>/<hash[0..2]>/<hash[2..]>.js`. Validation on
    // every put + get below means `hash` is always 64 lowercase hex.
    return join(this.root, hash.slice(0, 2), `${hash.slice(2)}.js`);
  }

  async put(hash: string, code: string): Promise<void> {
    if (!CODE_HASH_REGEX.test(hash)) {
      throw new Error(
        `FileSystemCodeStore.put: hash must match ${CODE_HASH_REGEX.source}, got ${JSON.stringify(hash)}`,
      );
    }
    const absPath = this.absPath(hash);
    // Idempotent: if the file already exists, skip rewrite. Cheap fast
    // path that avoids unnecessary disk churn when the same blueprint
    // is pushed repeatedly.
    if (await fileExists(absPath)) return;
    await mkdir(dirname(absPath), { recursive: true });
    // Temp-file + rename for atomic-or-throw write; readers never see
    // partial bytes.
    const tmpPath = `${absPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmpPath, code, { encoding: 'utf-8' });
    await rename(tmpPath, absPath);
  }

  async get(hash: string): Promise<string | null> {
    if (!CODE_HASH_REGEX.test(hash)) return null;
    try {
      return await readFile(this.absPath(hash), { encoding: 'utf-8' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  hashOf(code: string): string {
    return createHash('sha256').update(code, 'utf-8').digest('hex');
  }
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
