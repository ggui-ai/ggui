import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { PortableBlueprint } from '@ggui-ai/protocol';

const MANIFEST = 'manifest.json';
const CODES_DIR = 'codes';
const ARTIFACT_SCHEMA_VERSION = 1 as const;

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
  readonly records: readonly PortableBlueprint[];
  /** Per-record problems (missing/unreadable code body); never throws on these. */
  readonly issues: readonly string[];
}

/** Read + reassemble records. Throws on a missing/invalid manifest or unknown schemaVersion. */
export async function readPoolArtifact(dir: string): Promise<ReadPoolResult> {
  let raw: string;
  try {
    raw = await readFile(join(dir, MANIFEST), 'utf-8');
  } catch (cause) {
    throw new Error(
      `seed pool: cannot read ${join(dir, MANIFEST)}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch (cause) {
    throw new Error(
      `seed pool: ${MANIFEST} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `seed pool: unsupported manifest schemaVersion ${String(manifest.schemaVersion)} (expected ${ARTIFACT_SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(manifest.blueprints)) {
    throw new Error('seed pool: manifest.blueprints is missing or not an array');
  }
  const records: PortableBlueprint[] = [];
  const issues: string[] = [];
  for (const entry of manifest.blueprints) {
    // The code ref comes from a (possibly untrusted) manifest — only honour
    // refs matching this codec's own filename shape so a crafted value like
    // `../../etc/passwd` cannot escape `codes/`.
    if (!CODE_REF_PATTERN.test(entry.codeRef)) {
      issues.push(`seed pool: invalid code reference ${entry.codeRef}; skipping blueprint`);
      continue;
    }
    let componentCode: string;
    try {
      componentCode = await readFile(join(dir, CODES_DIR, entry.codeRef), 'utf-8');
    } catch {
      issues.push(`seed pool: missing code body ${entry.codeRef}; skipping blueprint`);
      continue;
    }
    records.push({ ...entry.record, componentCode });
  }
  return { records, issues };
}
