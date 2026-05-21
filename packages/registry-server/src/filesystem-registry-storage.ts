/**
 * Filesystem-backed {@link RegistryStorage} for the OSS registry
 * server. Row-per-file under `<root>/state/`:
 *
 *   <root>/state/plugins/<encoded artifactId>.json     → ArtifactsMetadataRow
 *   <root>/state/versions/<encoded artifactId>__<v>.json → ArtifactVersionRow
 *   <root>/state/author-keys/<subject>__<keyId>.json   → AuthorKeyRow
 *
 * The `__` separator is chosen because npm pkg names + semvers never
 * contain it (semver disallows underscores entirely; npm names disallow
 * leading underscores). `artifactId` contains `/` so we URL-encode the
 * whole id; encoded form is filename-safe + reversible.
 *
 * ## Atomic conflict detection
 *
 * {@link putArtifactVersionIfAbsent} uses `fs.writeFile(..., { flag: 'wx' })`
 * — the open(2) `O_EXCL` flag. `wx` fails with `EEXIST` if the file is
 * already present, which we map to `{ ok: false, reason: 'version_exists' }`.
 * Mirrors DDB's `ConditionExpression: attribute_not_exists(...)`. The
 * happy-path write is atomic at the inode level — partial writes on
 * crash leave the file absent rather than half-populated.
 *
 * ## Path-traversal defense
 *
 * Every `artifactId` is URL-encoded before becoming a filename, so
 * `../` characters in arbitrary input are turned into `%2E%2E%2F` and
 * cannot escape the directory. We also defensively reject any input
 * containing literal `..`, `/`, or `\\` at the row-key boundary even
 * though the manifest schema regex already rejects them — defense in
 * depth, the cost is two `String#includes` calls per write.
 *
 * ## Scan semantics
 *
 * {@link scanArtifacts} reads every metadata file, applies the same
 * AND-composition filter the memory impl does, and slices the result
 * to `[offset, offset+limit)`. Cursor is an integer offset encoded as
 * a base-10 string — opaque to consumers, identical to memory's
 * encoding. For typical OSS deployments (< 10k artifacts) the full
 * scan is sub-millisecond; large deployments should migrate to the
 * cloud DDB adapter.
 *
 * ## Protocol & Contract Bar
 *
 * Inherits the {@link RegistryStorage} interface contract verbatim.
 * Additional impl-specific obligations:
 *
 * **Obligations:**
 * - Every method MUST be safe to call before the underlying directory
 *   exists. The impl `mkdir -p`s on first write; reads return `null`
 *   on `ENOENT` at any level.
 *
 * **Failure mode:**
 * - Transport-level failures (disk full, permission denied) throw.
 *   `publishArtifact` wraps and returns 500. `ENOENT` on a read is
 *   NOT a transport failure — it's a "row absent" signal, returns `null`.
 *
 * **Observable violation:**
 * - Contract test `filesystem-registry-storage.test.ts` runs the full
 *   {@link registryStorageContract} suite against a fresh tmpdir per
 *   test. Plus path-traversal rejection tests local to this file.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AuthorKeyRow,
  ArtifactScanFilter,
  ArtifactVersionRow,
  ArtifactsMetadataRow,
  CompiledBlobRow,
  RegistryStorage,
} from '@ggui-ai/registry-core';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface FilesystemRegistryStorageOptions {
  /** Absolute path to the state root. Must already exist or be `mkdir -p`-able. */
  readonly root: string;
}

export function createFilesystemRegistryStorage(
  options: FilesystemRegistryStorageOptions,
): RegistryStorage {
  const stateRoot = join(options.root, 'state');
  const pluginsDir = join(stateRoot, 'plugins');
  const versionsDir = join(stateRoot, 'versions');
  const authorKeysDir = join(stateRoot, 'author-keys');
  // Content-addressed compiled-blob rows. Filenames are the 64-char
  // hex digest + `.json`. The digest itself is filename-safe (hex
  // chars only), so no URL-encoding is needed.
  const compiledBlobsDir = join(stateRoot, 'compiled-blobs');

  const compiledBlobPath = (compiledDigest: string): string => {
    rejectTraversal(compiledDigest, 'compiledDigest');
    return join(compiledBlobsDir, `${compiledDigest}.json`);
  };

  const metadataPath = (artifactId: string): string =>
    join(pluginsDir, `${encodeRowKey(artifactId)}.json`);

  const versionPath = (artifactId: string, version: string): string => {
    rejectTraversal(version, 'version');
    return join(
      versionsDir,
      `${encodeRowKey(artifactId)}__${encodeRowKey(version)}.json`,
    );
  };

  const authorKeyPath = (subject: string, keyId: string): string => {
    rejectTraversal(subject, 'subject');
    rejectTraversal(keyId, 'keyId');
    return join(
      authorKeysDir,
      `${encodeRowKey(subject)}__${encodeRowKey(keyId)}.json`,
    );
  };

  return {
    async getArtifactMetadata(artifactId) {
      return readJsonOrNull<ArtifactsMetadataRow>(metadataPath(artifactId));
    },
    async putArtifactMetadata(row) {
      await ensureDir(pluginsDir);
      await writeJson(metadataPath(row.artifactId), row);
    },
    async scanArtifacts(filter) {
      const rows = await readAllMetadata(pluginsDir);
      const filtered = rows.filter((row) => rowMatchesFilter(row, filter));
      const limit = clampLimit(filter.limit);
      const offset = parseCursor(filter.cursor);
      const page = filtered.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const nextCursor = nextOffset < filtered.length ? String(nextOffset) : undefined;
      return { rows: page, nextCursor };
    },
    async getArtifactVersion(artifactId, version) {
      return readJsonOrNull<ArtifactVersionRow>(versionPath(artifactId, version));
    },
    async listArtifactVersions(artifactId) {
      // Walk the versions/ directory; pick filenames whose URL-encoded
      // artifactId prefix matches. The `__` separator is safe because
      // semver versions never contain `__` (semver: ASCII alphanum +
      // `.` + `-`) and the URL-encoded artifactId can't contain `__`
      // either (encoder maps `_` → `_`, never doubles it).
      const prefix = `${encodeRowKey(artifactId)}__`;
      let entries: string[];
      try {
        entries = await readdir(versionsDir);
      } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') return [];
        throw err;
      }
      const matches: ArtifactVersionRow[] = [];
      for (const entry of entries) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
        const row = await readJsonOrNull<ArtifactVersionRow>(
          join(versionsDir, entry),
        );
        if (row !== null) matches.push(row);
      }
      return matches;
    },
    async putArtifactVersionIfAbsent(row) {
      await ensureDir(versionsDir);
      const path = versionPath(row.artifactId, row.version);
      try {
        await writeFile(path, JSON.stringify(row, null, 2), {
          flag: 'wx',
          encoding: 'utf8',
        });
        return { ok: true };
      } catch (err) {
        if (isErrnoException(err) && err.code === 'EEXIST') {
          return { ok: false, reason: 'version_exists' };
        }
        throw err;
      }
    },
    async yankArtifactVersion(artifactId, version) {
      const path = versionPath(artifactId, version);
      const existing = await readJsonOrNull<ArtifactVersionRow>(path);
      if (existing === null) return;
      const yanked: ArtifactVersionRow = { ...existing, yanked: true };
      await writeJson(path, yanked);
    },
    async getCompiledBlob(compiledDigest) {
      return readJsonOrNull<CompiledBlobRow>(compiledBlobPath(compiledDigest));
    },
    async commitVersionAndBlob(versionRow, blobRow) {
      // Atomic write — the filesystem impl gets its atomicity from the
      // JS event loop (single-writer assumption; the server runs one
      // process). The version-row write goes first using `wx`
      // (O_EXCL); on EEXIST we surface `version_exists` WITHOUT
      // touching the blob row. If the version write succeeds, we then
      // either INSERT a new blob row or read+rewrite the existing
      // one's refCount.
      await ensureDir(versionsDir);
      await ensureDir(compiledBlobsDir);
      const vPath = versionPath(versionRow.artifactId, versionRow.version);
      try {
        await writeFile(vPath, JSON.stringify(versionRow, null, 2), {
          flag: 'wx',
          encoding: 'utf8',
        });
      } catch (err) {
        if (isErrnoException(err) && err.code === 'EEXIST') {
          return { ok: false, reason: 'version_exists' };
        }
        throw err;
      }
      // Version row is durable. Now the blob row — INSERT-or-bump.
      const blobFsPath = compiledBlobPath(blobRow.compiledDigest);
      try {
        await writeFile(blobFsPath, JSON.stringify(blobRow, null, 2), {
          flag: 'wx',
          encoding: 'utf8',
        });
        return { ok: true, mode: 'new-blob' };
      } catch (err) {
        if (isErrnoException(err) && err.code === 'EEXIST') {
          // Dedup — read the existing row and bump refCount.
          const existing = await readJsonOrNull<CompiledBlobRow>(blobFsPath);
          if (existing === null) {
            // Vanished between EEXIST and read — treat as race; the
            // single-writer OSS server doesn't have a delete path so
            // this is a corruption signal we surface as a throw.
            throw new Error(
              `commitVersionAndBlob: blob row vanished between EEXIST and read for compiledDigest=${blobRow.compiledDigest}`,
            );
          }
          const updated: CompiledBlobRow = {
            ...existing,
            refCount: existing.refCount + 1,
          };
          await writeJson(blobFsPath, updated);
          return { ok: true, mode: 'dedup' };
        }
        throw err;
      }
    },
    async getAuthorKey(subject, keyId) {
      return readJsonOrNull<AuthorKeyRow>(authorKeyPath(subject, keyId));
    },
    async putAuthorKey(row) {
      await ensureDir(authorKeysDir);
      await writeJson(authorKeyPath(row.subject, row.keyId), row);
    },
    async listAuthorKeys(subject) {
      const prefix = `${encodeRowKey(subject)}__`;
      let entries: string[];
      try {
        entries = await readdir(authorKeysDir);
      } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') return [];
        throw err;
      }
      const matches: AuthorKeyRow[] = [];
      for (const entry of entries) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
        const row = await readJsonOrNull<AuthorKeyRow>(join(authorKeysDir, entry));
        if (row !== null) matches.push(row);
      }
      return matches;
    },
  };
}

/**
 * URL-encode the key. Filename-safe + reversible. `/` becomes `%2F`,
 * `..` becomes `..` (allowed because the manifest schema rejects it
 * before we ever get here, AND we `rejectTraversal` defensively) but
 * even if it slipped through, the encoded form is what gets joined to
 * the directory — `..` as a literal filename segment is just a file
 * named `..`, not a directory traversal.
 */
function encodeRowKey(key: string): string {
  return encodeURIComponent(key);
}

/**
 * Defensive path-traversal reject. The manifest schema regex blocks
 * `..`, `/`, and `\\` at parse time. This is a second wall — if a
 * caller bypasses the schema (programmatic injection from a fuzzed
 * test, future row type added without schema coverage), the storage
 * layer still rejects.
 */
function rejectTraversal(value: string, fieldName: string): void {
  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new Error(
      `path-traversal: filesystem storage rejects ${fieldName}=${JSON.stringify(value)} (contains "..", "/", or "\\")`,
    );
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function readAllMetadata(
  pluginsDir: string,
): Promise<readonly ArtifactsMetadataRow[]> {
  let entries: string[];
  try {
    entries = await readdir(pluginsDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return [];
    throw err;
  }
  const rows: ArtifactsMetadataRow[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const row = await readJsonOrNull<ArtifactsMetadataRow>(join(pluginsDir, entry));
    if (row !== null) rows.push(row);
  }
  return rows;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit)) return DEFAULT_LIMIT;
  if (limit < 1) return 1;
  if (limit > MAX_LIMIT) return MAX_LIMIT;
  return limit;
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  const n = Number.parseInt(cursor, 10);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * Mirrors {@link inMemoryRegistryStorage}'s filter — same
 * AND-composition, same case-insensitive substring match on q, same
 * publisher-sub OR author-name match. Kept inline so the filesystem
 * impl doesn't depend on a private helper from registry-core.
 */
function rowMatchesFilter(row: ArtifactsMetadataRow, q: ArtifactScanFilter): boolean {
  if (q.kind !== undefined && row.kind !== q.kind) return false;
  if (q.hook !== undefined && row.hook !== q.hook) return false;

  if (q.tag !== undefined) {
    if (row.tags === undefined || !row.tags.includes(q.tag)) return false;
  }

  if (q.author !== undefined) {
    const matchesSub = row.publishedBy === q.author;
    const matchesName =
      row.authorName !== undefined &&
      row.authorName.toLowerCase().includes(q.author.toLowerCase());
    if (!matchesSub && !matchesName) return false;
  }

  if (q.q !== undefined) {
    const needle = q.q.toLowerCase();
    const slashIdx = row.artifactId.indexOf('/');
    const namePart = slashIdx >= 0 ? row.artifactId.slice(slashIdx + 1) : row.artifactId;
    const inName = namePart.toLowerCase().includes(needle);
    const inDescription =
      row.description !== undefined && row.description.toLowerCase().includes(needle);
    const inTags =
      row.tags !== undefined && row.tags.some((t) => t.toLowerCase().includes(needle));
    if (!inName && !inDescription && !inTags) return false;
  }

  return true;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
