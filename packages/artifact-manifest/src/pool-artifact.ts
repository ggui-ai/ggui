/**
 * Pool-artifact wrapper codec — the SINGLE owner of the seed-pool
 * artifact byte format (schemaVersion 2).
 *
 * A seed-pool artifact is a directory-shaped bundle of exported
 * blueprints that one deployment writes and another reads:
 *
 *   - `manifest.json` — `{ schemaVersion: 2, blueprints: [{ record:
 *     <PortableBlueprint minus componentCode>, codeRef:
 *     "<sha256hex>.tsx" }] }`, UTF-8.
 *   - `codes/<codeRef>` — raw UTF-8 component-code body (NOT
 *     JSON-wrapped). Readers reconstruct each record as
 *     `{ ...entry.record, componentCode }`.
 *
 * This module owns everything FORMAT: the schema-version literal, the
 * layout names (`manifest.json`, `codes/`), the codeRef filename
 * shape, the manifest types, the (de)serializers, and the canonical
 * rejection/issue messages. Writers and readers — whatever transport
 * they sit on (local filesystem, object storage) — import from here
 * and own ONLY their IO: byte fetch/store and code-body splice. A
 * future schemaVersion bump is therefore a single-point change; a
 * writer and a reader can never disagree on the format.
 *
 * Records stay UNVALIDATED here (`record: object`): artifact bytes are
 * an untrusted input, and the trust boundary for record shape is the
 * protocol's `fromPortableBlueprint` inside the seed-pool builder
 * (skip-with-log on rejection — a rejected seed entry is just a
 * cold-gen). This codec validates only the wrapper: version, layout,
 * entry shape, codeRef shape.
 *
 * Versioning: the wrapper version is bumped in lockstep with the
 * record schema (`PORTABLE_BLUEPRINT_SCHEMA_VERSION`). v1 artifacts
 * are rejected on read with {@link POOL_ARTIFACT_V1_REJECTION} — a
 * blueprint pool is a cache, so the fix is a re-export, never a
 * migration shim.
 */

/**
 * Wrapper-artifact schema version. Bumped 1 → 2 in lockstep with
 * PortableBlueprint v2 (records now carry required provenance).
 */
export const POOL_ARTIFACT_SCHEMA_VERSION = 2;

/** Manifest filename inside the artifact directory/prefix. */
export const POOL_ARTIFACT_MANIFEST_FILENAME = 'manifest.json';

/** Code-body directory name inside the artifact directory/prefix. */
export const POOL_ARTIFACT_CODES_DIR = 'codes';

/**
 * The codec's code-body filename shape: `<sha256 hex>.tsx`. Readers
 * MUST honour only refs matching this pattern so a crafted manifest
 * value like `../../etc/passwd` can never escape `codes/`.
 */
export const POOL_ARTIFACT_CODE_REF_PATTERN = /^[0-9a-f]{64}\.tsx$/;

/** Rejection message for schemaVersion-1 wrapper artifacts. */
export const POOL_ARTIFACT_V1_REJECTION =
  're-export the pool: artifact schemaVersion 2 records carry complete provenance (PortableBlueprint v2)';

/**
 * One manifest entry. `record` is deliberately untyped beyond "an
 * object": the inner record is untrusted artifact bytes readers
 * forward verbatim; `fromPortableBlueprint` at the pool builder is
 * the validating narrower.
 */
export interface PoolArtifactManifestEntry {
  readonly record: object;
  readonly codeRef: string; // `<sha256 hex>.tsx`
}

export interface PoolArtifactManifest {
  readonly schemaVersion: typeof POOL_ARTIFACT_SCHEMA_VERSION;
  readonly blueprints: readonly PoolArtifactManifestEntry[];
}

/**
 * Build the codeRef filename for a code body's sha256 hex digest.
 * Throws when the input is not a 64-char lowercase hex digest — a
 * writer must never produce a ref its own reader would reject.
 */
export function poolArtifactCodeRef(sha256Hex: string): string {
  const ref = `${sha256Hex}.tsx`;
  if (!POOL_ARTIFACT_CODE_REF_PATTERN.test(ref)) {
    throw new Error(
      `pool artifact: codeRef input is not a sha256 hex digest: ${sha256Hex}`,
    );
  }
  return ref;
}

/** Stamp the current schema version onto a manifest. Writer-side. */
export function buildPoolArtifactManifest(
  blueprints: readonly PoolArtifactManifestEntry[],
): PoolArtifactManifest {
  return { schemaVersion: POOL_ARTIFACT_SCHEMA_VERSION, blueprints };
}

/** Canonical manifest bytes (pretty-printed JSON + trailing newline). */
export function serializePoolArtifactManifest(
  manifest: PoolArtifactManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Parse + validate raw manifest bytes.
 *
 * Failure modes (the codec's contract, shared by every reader):
 *   - Manifest-level problems — invalid JSON, non-object root, an
 *     unsupported `schemaVersion` (v1 included), a missing/non-array
 *     `blueprints` — return `{ok: false, reason}`. Readers THROW,
 *     prefixing their transport context.
 *   - Entry-level problems — a malformed entry or a codeRef failing
 *     {@link POOL_ARTIFACT_CODE_REF_PATTERN} — DROP the entry and
 *     append a canonical message to `issues`. Readers surface issues
 *     (warn/collect), never throw on them: a single bad row is a
 *     skipped blueprint, not a dead pool.
 */
export type ParsePoolArtifactManifestResult =
  | {
      readonly ok: true;
      readonly manifest: PoolArtifactManifest;
      readonly issues: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

export function parsePoolArtifactManifest(
  raw: string,
): ParsePoolArtifactManifestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      reason: `${POOL_ARTIFACT_MANIFEST_FILENAME} is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `${POOL_ARTIFACT_MANIFEST_FILENAME} is not an object`,
    };
  }
  const m = parsed as { schemaVersion?: unknown; blueprints?: unknown };
  if (m.schemaVersion !== POOL_ARTIFACT_SCHEMA_VERSION) {
    if (m.schemaVersion === 1) {
      return { ok: false, reason: POOL_ARTIFACT_V1_REJECTION };
    }
    return {
      ok: false,
      reason: `unsupported manifest schemaVersion ${String(m.schemaVersion)} (expected ${POOL_ARTIFACT_SCHEMA_VERSION})`,
    };
  }
  if (!Array.isArray(m.blueprints)) {
    return {
      ok: false,
      reason: 'manifest.blueprints is missing or not an array',
    };
  }
  const blueprints: PoolArtifactManifestEntry[] = [];
  const issues: string[] = [];
  for (const entry of m.blueprints as readonly unknown[]) {
    if (!isPoolArtifactManifestEntry(entry)) {
      issues.push(
        'malformed manifest entry (missing record/codeRef); skipping blueprint',
      );
      continue;
    }
    if (!POOL_ARTIFACT_CODE_REF_PATTERN.test(entry.codeRef)) {
      issues.push(
        `invalid code reference ${entry.codeRef}; skipping blueprint`,
      );
      continue;
    }
    blueprints.push(entry);
  }
  return {
    ok: true,
    manifest: { schemaVersion: POOL_ARTIFACT_SCHEMA_VERSION, blueprints },
    issues,
  };
}

/**
 * Structural guard for a manifest entry: `codeRef` is a string and
 * `record` is an object readers can splice `componentCode` back into.
 * The record's inner fields are deliberately NOT validated here — see
 * the module docstring's trust-boundary note.
 */
function isPoolArtifactManifestEntry(
  value: unknown,
): value is PoolArtifactManifestEntry {
  if (typeof value !== 'object' || value === null) return false;
  if (!('codeRef' in value) || typeof value.codeRef !== 'string') return false;
  if (
    !('record' in value) ||
    typeof value.record !== 'object' ||
    value.record === null ||
    Array.isArray(value.record)
  ) {
    return false;
  }
  return true;
}
