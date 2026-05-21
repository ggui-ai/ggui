/**
 * In-process {@link RegistryStorage} — process-local Maps for the
 * metadata, version, and author-key tables. Used by the OSS server's
 * `--storage=memory` mode, by registry-core unit tests, and by e2e
 * harnesses that spin up a fresh registry per scenario.
 *
 * Filter semantics on {@link scanArtifacts} match every other storage
 * impl exactly — same AND-composition, same case-insensitive substring
 * match on q, same publisher-subject OR author-name match. Cursor is an
 * integer offset encoded as a base-10 string.
 */
import type {
  AuthorKeyRow,
  ArtifactScanFilter,
  ArtifactVersionRow,
  ArtifactsMetadataRow,
  CompiledBlobRow,
} from '../types.js';
import {
  AuthorKeyAlreadyExistsError,
  type RegistryStorage,
} from '../interfaces/registry-storage.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function inMemoryRegistryStorage(): RegistryStorage {
  const metadata = new Map<string, ArtifactsMetadataRow>();
  const versions = new Map<string, ArtifactVersionRow>();
  const authorKeys = new Map<string, AuthorKeyRow>();
  const compiledBlobs = new Map<string, CompiledBlobRow>();

  const versionKey = (artifactId: string, version: string): string =>
    `${artifactId}@${version}`;
  const authorKey = (subject: string, keyId: string): string =>
    `${subject}/${keyId}`;

  return {
    async getArtifactMetadata(artifactId) {
      return metadata.get(artifactId) ?? null;
    },
    async putArtifactMetadata(row) {
      metadata.set(row.artifactId, row);
    },
    async scanArtifacts(filter) {
      const rows = Array.from(metadata.values()).filter((row) => rowMatchesFilter(row, filter));
      const limit = clampLimit(filter.limit);
      const offset = parseCursor(filter.cursor);
      const page = rows.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const nextCursor = nextOffset < rows.length ? String(nextOffset) : undefined;
      return { rows: page, nextCursor };
    },
    async getArtifactVersion(artifactId, version) {
      return versions.get(versionKey(artifactId, version)) ?? null;
    },
    async listArtifactVersions(artifactId) {
      // Walk the version map and pick the rows whose composite key
      // starts with `<artifactId>@`. The `@` separator is safe because
      // it's reserved in semver (versions never contain `@`) and
      // `artifactId` always contains `/` (never `@`), so the boundary
      // is unambiguous.
      const prefix = `${artifactId}@`;
      const matches: ArtifactVersionRow[] = [];
      for (const [key, row] of versions) {
        if (key.startsWith(prefix)) matches.push(row);
      }
      return matches;
    },
    async putArtifactVersionIfAbsent(row) {
      const key = versionKey(row.artifactId, row.version);
      if (versions.has(key)) {
        return { ok: false, reason: 'version_exists' };
      }
      versions.set(key, row);
      return { ok: true };
    },
    async yankArtifactVersion(artifactId, version) {
      const key = versionKey(artifactId, version);
      const existing = versions.get(key);
      if (existing === undefined) return;
      versions.set(key, { ...existing, yanked: true });
    },
    async getCompiledBlob(compiledDigest) {
      return compiledBlobs.get(compiledDigest) ?? null;
    },
    async commitVersionAndBlob(versionRow, blobRow) {
      // Atomic write — the in-memory impl is structurally atomic via
      // the JS event loop. We pre-check both conditions BEFORE
      // mutating either map so a version-row conflict leaves BOTH
      // maps untouched (mirrors the DDB transaction's all-or-nothing
      // semantics from the caller's perspective).
      const vKey = versionKey(versionRow.artifactId, versionRow.version);
      if (versions.has(vKey)) {
        return { ok: false, reason: 'version_exists' };
      }
      const existingBlob = compiledBlobs.get(blobRow.compiledDigest);
      if (existingBlob === undefined) {
        // New-blob path — both rows INSERT.
        versions.set(vKey, versionRow);
        compiledBlobs.set(blobRow.compiledDigest, blobRow);
        return { ok: true, mode: 'new-blob' };
      }
      // Dedup path — version INSERT + refCount bump on existing blob.
      versions.set(vKey, versionRow);
      compiledBlobs.set(blobRow.compiledDigest, {
        ...existingBlob,
        refCount: existingBlob.refCount + 1,
      });
      return { ok: true, mode: 'dedup' };
    },
    async getAuthorKey(subject, keyId) {
      return authorKeys.get(authorKey(subject, keyId)) ?? null;
    },
    async putAuthorKey(row, options) {
      const key = authorKey(row.subject, row.keyId);
      if (options?.ifNotExists === true && authorKeys.has(key)) {
        throw new AuthorKeyAlreadyExistsError(row.subject, row.keyId);
      }
      authorKeys.set(key, row);
    },
    async listAuthorKeys(subject) {
      const prefix = `${subject}/`;
      const matches: AuthorKeyRow[] = [];
      for (const [key, row] of authorKeys) {
        if (key.startsWith(prefix)) matches.push(row);
      }
      return matches;
    },
  };
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
