import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { PortableBlueprint } from '@ggui-ai/protocol';

const MANIFEST = 'manifest.json';
const CODES_DIR = 'codes';
/**
 * Wrapper-artifact schema version. Bumped 1 → 2 in lockstep with
 * PortableBlueprint v2 (records now carry required provenance). v1
 * artifacts are rejected on read — a blueprint pool is a cache, so
 * the fix is a re-export, never a migration shim.
 */
const ARTIFACT_SCHEMA_VERSION = 2 as const;

/** Rejection message for schemaVersion-1 wrapper artifacts. */
export const POOL_ARTIFACT_V1_REJECTION =
  're-export the pool: artifact schemaVersion 2 records carry complete provenance (PortableBlueprint v2)';

interface ManifestEntry {
  readonly record: Omit<PortableBlueprint, 'componentCode'>;
  readonly codeRef: string; // `<codeHash>.tsx`
}
interface Manifest {
  readonly schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  readonly blueprints: readonly ManifestEntry[];
}

const codeHash = (code: string): string =>
  createHash('sha256').update(code, 'utf-8').digest('hex');

/** Matches the codec's own code-body filename: `<sha256 hex>.tsx`. */
const CODE_REF_PATTERN = /^[0-9a-f]{64}\.tsx$/;

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
  await rm(join(dir, CODES_DIR), { recursive: true, force: true });
  await rm(join(dir, MANIFEST), { force: true });
  await mkdir(join(dir, CODES_DIR), { recursive: true });
  const entries: ManifestEntry[] = [];
  for (const r of records) {
    const hash = codeHash(r.componentCode);
    const codeRef = `${hash}.tsx`;
    await writeFile(join(dir, CODES_DIR, codeRef), r.componentCode, 'utf-8');
    const { componentCode: _omit, ...rest } = r;
    entries.push({ record: rest, codeRef });
  }
  const manifest: Manifest = { schemaVersion: ARTIFACT_SCHEMA_VERSION, blueprints: entries };
  await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export interface ReadPoolResult {
  /**
   * Raw, UNVALIDATED records (manifest entry + reassembled
   * componentCode). The artifact bytes are an untrusted input; the
   * trust boundary is `fromPortableBlueprint` at the loader
   * (`buildSeedPool`), which validates each record and skips
   * rejections with a log line. This codec only owns the directory
   * layout (manifest + codes/), never the record shape.
   */
  readonly records: readonly unknown[];
  /** Per-record problems (missing/unreadable code body); never throws on these. */
  readonly issues: readonly string[];
}

/** Read + reassemble records. Throws on a missing/invalid manifest or unsupported schemaVersion (v1 included — re-export, no migration shim). */
export async function readPoolArtifact(dir: string): Promise<ReadPoolResult> {
  let raw: string;
  try {
    raw = await readFile(join(dir, MANIFEST), 'utf-8');
  } catch (cause) {
    throw new Error(
      `seed pool: cannot read ${join(dir, MANIFEST)}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new Error(
      `seed pool: ${MANIFEST} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error(`seed pool: ${MANIFEST} is not an object`);
  }
  const m = manifest as Record<string, unknown>;
  if (m['schemaVersion'] !== ARTIFACT_SCHEMA_VERSION) {
    if (m['schemaVersion'] === 1) {
      throw new Error(`seed pool: ${POOL_ARTIFACT_V1_REJECTION}`);
    }
    throw new Error(
      `seed pool: unsupported manifest schemaVersion ${String(m['schemaVersion'])} (expected ${ARTIFACT_SCHEMA_VERSION})`,
    );
  }
  const blueprints = m['blueprints'];
  if (!Array.isArray(blueprints)) {
    throw new Error('seed pool: manifest.blueprints is missing or not an array');
  }
  const records: unknown[] = [];
  const issues: string[] = [];
  for (const entry of blueprints as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      issues.push('seed pool: malformed manifest entry (not an object); skipping blueprint');
      continue;
    }
    const e = entry as Record<string, unknown>;
    const codeRef = e['codeRef'];
    const record = e['record'];
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      issues.push('seed pool: malformed manifest entry (no record object); skipping blueprint');
      continue;
    }
    // The code ref comes from a (possibly untrusted) manifest — only honour
    // refs matching this codec's own filename shape so a crafted value like
    // `../../etc/passwd` cannot escape `codes/`.
    if (typeof codeRef !== 'string' || !CODE_REF_PATTERN.test(codeRef)) {
      issues.push(`seed pool: invalid code reference ${String(codeRef)}; skipping blueprint`);
      continue;
    }
    let componentCode: string;
    try {
      componentCode = await readFile(join(dir, CODES_DIR, codeRef), 'utf-8');
    } catch {
      issues.push(`seed pool: missing code body ${codeRef}; skipping blueprint`);
      continue;
    }
    records.push({ ...(record as Record<string, unknown>), componentCode });
  }
  return { records, issues };
}
