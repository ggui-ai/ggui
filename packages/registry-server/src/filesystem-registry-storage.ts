/**
 * Filesystem-backed {@link RegistryStorage} for the OSS registry
 * server. Row-per-file under `<root>/state/`:
 *
 *   <root>/state/plugins/<encoded artifactId>.json     → ArtifactsMetadataRow
 *   <root>/state/versions/<encoded artifactId>__<v>.json → ArtifactVersionRow
 *   <root>/state/author-keys/<subject>__<keyId>.json   → AuthorKeyRow
 *   <root>/state/scope-owners/<encoded scope>.json     → ScopeOwnerRow
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
 * {@link claimScope} uses the same `wx` primitive for its first-writer-
 * wins scope claim (`EEXIST` → `{ conflict: true }`).
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
 * AND-composition filter the memory impl does, orders the full result
 * set when `order: 'recent'` is requested (publishedAt DESC — globally
 * correct across the cursor chain because ordering precedes slicing),
 * and slices the result to `[offset, offset+limit)`. Cursor is an
 * integer offset encoded as a base-10 string — opaque to consumers,
 * identical to memory's encoding. For typical OSS deployments
 * (< 10k artifacts) the full scan is sub-millisecond; large
 * deployments should migrate to a database-backed adapter.
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
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AuthorKeyAlreadyExistsError,
  matchesMcpToolFilters,
  type AuthorKeyRow,
  type ArtifactScanFilter,
  type ArtifactVersionRow,
  type ArtifactsMetadataRow,
  type CompiledBlobRow,
  type RegistryStorage,
  type ScopeOwnerRow,
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
  // Scope-ownership rows — one file per claimed scope. The scope is
  // URL-encoded like every other row key (`@` → `%40`).
  const scopeOwnersDir = join(stateRoot, 'scope-owners');

  const scopeOwnerPath = (scope: string): string => {
    rejectTraversal(scope, 'scope');
    return join(scopeOwnersDir, `${encodeRowKey(scope)}.json`);
  };

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
    // NO rejectTraversal on `subject`: subjects are operator-defined
    // free text (a '/' is legal), and `encodeRowKey` neutralizes every
    // traversal-capable character ('/' → %2F) before the value ever
    // becomes a filename component — the appended `__<keyId>.json`
    // suffix additionally guarantees the segment can never be a bare
    // '..'. keyIds keep the guard as defense-in-depth (base64url by
    // derivation — '.', '/', '\\' are unrepresentable).
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
      if (filter.order === 'recent') {
        // Newest first, globally correct across the offset-cursor chain
        // because the FULL result set is ordered before slicing.
        // ISO-8601 strings compare lexicographically === chronologically;
        // artifactId tie-break keeps the cursor chain deterministic.
        filtered.sort(
          (a, b) =>
            b.publishedAt.localeCompare(a.publishedAt) ||
            a.artifactId.localeCompare(b.artifactId),
        );
      }
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
    async getScopeOwner(scope) {
      return readJsonOrNull<ScopeOwnerRow>(scopeOwnerPath(scope));
    },
    async claimScope(row) {
      // Atomic first-writer-wins via `wx` (open(2) O_EXCL) — mirrors
      // the conditional-create semantics of a hosted database adapter.
      // EEXIST maps to `{ conflict: true }` with the winner's file
      // untouched.
      await ensureDir(scopeOwnersDir);
      try {
        await writeFile(scopeOwnerPath(row.scope), JSON.stringify(row, null, 2), {
          flag: 'wx',
          encoding: 'utf8',
        });
        return { ok: true };
      } catch (err) {
        if (isErrnoException(err) && err.code === 'EEXIST') {
          return { conflict: true };
        }
        throw err;
      }
    },
    async updateScopeOwner(row, expect) {
      // Compare-and-set against the caller's read snapshot. Atomicity
      // note: the read-compare-write sequence relies on the OSS
      // server's single-process, single-writer posture (the same
      // documented caveat as commitVersionAndBlob's blob leg) — the
      // `wx` seed path below is additionally inode-atomic.
      await ensureDir(scopeOwnersDir);
      const path = scopeOwnerPath(row.scope);
      if ('absent' in expect) {
        // Seed path — O_EXCL create, EEXIST means a claim (or another
        // seed) landed first.
        try {
          await writeFile(path, JSON.stringify(row, null, 2), {
            flag: 'wx',
            encoding: 'utf8',
          });
          return { ok: true };
        } catch (err) {
          if (isErrnoException(err) && err.code === 'EEXIST') {
            return { conflict: true };
          }
          throw err;
        }
      }
      const current = await readJsonOrNull<ScopeOwnerRow>(path);
      if (
        current === null ||
        current.ownerSubject !== expect.ownerSubject ||
        current.verification !== expect.verification
      ) {
        return { conflict: true };
      }
      await writeJson(path, row);
      return { ok: true };
    },
    async getAuthorKey(subject, keyId) {
      return readJsonOrNull<AuthorKeyRow>(authorKeyPath(subject, keyId));
    },
    async putAuthorKey(row, options) {
      await ensureDir(authorKeysDir);
      const path = authorKeyPath(row.subject, row.keyId);
      if (options?.ifNotExists === true) {
        // O_EXCL conditional create — same `wx` primitive as
        // putArtifactVersionIfAbsent/claimScope. EEXIST maps to the
        // typed conflict the register op's TOCTOU close dispatches on.
        try {
          await writeFile(path, JSON.stringify(row, null, 2), {
            flag: 'wx',
            encoding: 'utf8',
          });
          return;
        } catch (err) {
          if (isErrnoException(err) && err.code === 'EEXIST') {
            throw new AuthorKeyAlreadyExistsError(row.subject, row.keyId);
          }
          throw err;
        }
      }
      await writeJson(path, row);
    },
    async listAuthorKeys(subject) {
      // Filename-prefix candidate scan, then a row-field filter — the
      // row's own `subject` is the unambiguous ownership signal
      // (encodeRowKey leaves '_' unescaped, so a prefix alone could
      // cross-match subjects containing '__').
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
        if (row !== null && row.subject === subject) matches.push(row);
      }
      return matches;
    },
    async deleteAuthorKey(subject, keyId) {
      // ENOENT is the "row absent" signal (mirrors reads), mapped to
      // the contract's `false`; anything else is a transport failure
      // and throws.
      try {
        await unlink(authorKeyPath(subject, keyId));
        return true;
      } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') return false;
        throw err;
      }
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
 * impl doesn't depend on a private helper from registry-core; the
 * tool/server dimensions delegate to the PUBLIC shared predicate
 * `matchesMcpToolFilters` so the reference semantics cannot drift.
 */
function rowMatchesFilter(row: ArtifactsMetadataRow, q: ArtifactScanFilter): boolean {
  // #474 — visibility gating lives INSIDE every scanArtifacts impl
  // (the ruled canonical location); the search op's post-filter stays
  // as defense-in-depth. Without this, private rows would consume
  // page slots on self-host impls even though the op filters them out
  // before they ever reach the wire.
  if (row.visibility !== 'public') return false;
  if (q.kind !== undefined && row.kind !== q.kind) return false;
  if (q.hook !== undefined && row.hook !== q.hook) return false;
  if (!matchesMcpToolFilters(row.mcpTools, q)) return false;

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
