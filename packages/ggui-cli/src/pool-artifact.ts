/**
 * Filesystem IO for the seed-pool wrapper artifact. The byte FORMAT
 * (schema version, layout names, codeRef shape, rejection/issue
 * messages) is owned by `@ggui-ai/artifact-manifest`'s pool-artifact
 * codec — this module owns only the directory IO: writing/reading the
 * manifest + code bodies and splicing `componentCode` back in.
 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  POOL_ARTIFACT_CODES_DIR,
  POOL_ARTIFACT_MANIFEST_FILENAME,
  buildPoolArtifactManifest,
  parsePoolArtifactManifest,
  poolArtifactCodeRef,
  serializePoolArtifactManifest,
  type PoolArtifactManifestEntry,
} from '@ggui-ai/artifact-manifest';
import type { PortableBlueprint } from '@ggui-ai/protocol';

const codeHash = (code: string): string =>
  createHash('sha256').update(code, 'utf-8').digest('hex');

/** Write records to a directory: manifest.json + codes/<hash>.tsx. */
export async function writePoolArtifact(
  dir: string,
  records: readonly PortableBlueprint[],
): Promise<void> {
  // Clear ONLY the files this codec owns, never the whole dir — the caller's
  // path (e.g. `--out .`) is passed through verbatim, so a recursive wipe of
  // `dir` would delete unrelated files. Removing `codes/` + the manifest still
  // guarantees no stale code bodies survive a rewrite.
  await mkdir(dir, { recursive: true });
  await rm(join(dir, POOL_ARTIFACT_CODES_DIR), { recursive: true, force: true });
  await rm(join(dir, POOL_ARTIFACT_MANIFEST_FILENAME), { force: true });
  await mkdir(join(dir, POOL_ARTIFACT_CODES_DIR), { recursive: true });
  const entries: PoolArtifactManifestEntry[] = [];
  for (const r of records) {
    const codeRef = poolArtifactCodeRef(codeHash(r.componentCode));
    await writeFile(
      join(dir, POOL_ARTIFACT_CODES_DIR, codeRef),
      r.componentCode,
      'utf-8',
    );
    const { componentCode: _omit, ...rest } = r;
    entries.push({ record: rest, codeRef });
  }
  await writeFile(
    join(dir, POOL_ARTIFACT_MANIFEST_FILENAME),
    serializePoolArtifactManifest(buildPoolArtifactManifest(entries)),
    'utf-8',
  );
}

export interface ReadPoolResult {
  /**
   * Raw, UNVALIDATED records (manifest entry + reassembled
   * componentCode). The artifact bytes are an untrusted input; the
   * trust boundary is `fromPortableBlueprint` at the loader
   * (`buildSeedPool`), which validates each record and skips
   * rejections with a log line. This reader only owns the directory
   * IO; the layout/format is the shared codec's.
   */
  readonly records: readonly unknown[];
  /** Per-record problems (malformed entry, bad ref, missing/unreadable code body); never throws on these. */
  readonly issues: readonly string[];
}

/** Read + reassemble records. Throws on a missing/invalid manifest or unsupported schemaVersion (v1 included — re-export, no migration shim). */
export async function readPoolArtifact(dir: string): Promise<ReadPoolResult> {
  let raw: string;
  try {
    raw = await readFile(join(dir, POOL_ARTIFACT_MANIFEST_FILENAME), 'utf-8');
  } catch (cause) {
    throw new Error(
      `seed pool: cannot read ${join(dir, POOL_ARTIFACT_MANIFEST_FILENAME)}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const parsed = parsePoolArtifactManifest(raw);
  if (!parsed.ok) {
    throw new Error(`seed pool: ${parsed.reason}`);
  }
  const records: unknown[] = [];
  const issues: string[] = parsed.issues.map((issue) => `seed pool: ${issue}`);
  for (const entry of parsed.manifest.blueprints) {
    let componentCode: string;
    try {
      componentCode = await readFile(
        join(dir, POOL_ARTIFACT_CODES_DIR, entry.codeRef),
        'utf-8',
      );
    } catch {
      issues.push(`seed pool: missing code body ${entry.codeRef}; skipping blueprint`);
      continue;
    }
    records.push({ ...entry.record, componentCode });
  }
  return { records, issues };
}
