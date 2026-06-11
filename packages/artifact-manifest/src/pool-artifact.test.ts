import { describe, expect, it } from 'vitest';
import {
  POOL_ARTIFACT_CODES_DIR,
  POOL_ARTIFACT_CODE_REF_PATTERN,
  POOL_ARTIFACT_MANIFEST_FILENAME,
  POOL_ARTIFACT_SCHEMA_VERSION,
  POOL_ARTIFACT_V1_REJECTION,
  buildPoolArtifactManifest,
  parsePoolArtifactManifest,
  poolArtifactCodeRef,
  serializePoolArtifactManifest,
} from './pool-artifact.js';

const HASH = 'a'.repeat(64);
const ENTRY = { record: { contractHash: 'sha256:x' }, codeRef: `${HASH}.tsx` };

describe('pool-artifact codec', () => {
  it('pins the wrapper format vocabulary (single-point bump surface)', () => {
    expect(POOL_ARTIFACT_SCHEMA_VERSION).toBe(2);
    expect(POOL_ARTIFACT_MANIFEST_FILENAME).toBe('manifest.json');
    expect(POOL_ARTIFACT_CODES_DIR).toBe('codes');
  });

  it('round-trips a manifest through serialize → parse', () => {
    const manifest = buildPoolArtifactManifest([ENTRY]);
    const parsed = parsePoolArtifactManifest(serializePoolArtifactManifest(manifest));
    expect(parsed).toEqual({ ok: true, manifest, issues: [] });
  });

  it('builds codeRefs its own pattern accepts; rejects non-digest input', () => {
    const ref = poolArtifactCodeRef(HASH);
    expect(ref).toBe(`${HASH}.tsx`);
    expect(POOL_ARTIFACT_CODE_REF_PATTERN.test(ref)).toBe(true);
    expect(() => poolArtifactCodeRef('deadbeef')).toThrow(/sha256/);
    expect(() => poolArtifactCodeRef('../escape')).toThrow(/sha256/);
  });

  it('rejects a v1 wrapper with the canonical re-export message', () => {
    const parsed = parsePoolArtifactManifest(
      JSON.stringify({ schemaVersion: 1, blueprints: [] }),
    );
    expect(parsed).toEqual({ ok: false, reason: POOL_ARTIFACT_V1_REJECTION });
  });

  it('rejects an unsupported schemaVersion naming both versions', () => {
    const parsed = parsePoolArtifactManifest(
      JSON.stringify({ schemaVersion: 3, blueprints: [] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toMatch(/schemaVersion 3/);
      expect(parsed.reason).toContain(`expected ${POOL_ARTIFACT_SCHEMA_VERSION}`);
    }
  });

  it('rejects invalid JSON, non-object roots, and non-array blueprints', () => {
    expect(parsePoolArtifactManifest('not json').ok).toBe(false);
    expect(parsePoolArtifactManifest('[]').ok).toBe(false);
    expect(
      parsePoolArtifactManifest(JSON.stringify({ schemaVersion: 2, blueprints: {} })),
    ).toEqual({ ok: false, reason: 'manifest.blueprints is missing or not an array' });
  });

  it('drops malformed entries with an issue, never a throw', () => {
    const parsed = parsePoolArtifactManifest(
      JSON.stringify({
        schemaVersion: 2,
        blueprints: [ENTRY, 'not-an-entry', { record: null, codeRef: `${HASH}.tsx` }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.blueprints).toEqual([ENTRY]);
      expect(parsed.issues).toHaveLength(2);
      expect(parsed.issues[0]).toMatch(/malformed manifest entry/);
    }
  });

  it('drops a path-traversal / wrong-shape codeRef at parse time', () => {
    const parsed = parsePoolArtifactManifest(
      JSON.stringify({
        schemaVersion: 2,
        blueprints: [
          { record: {}, codeRef: '../../etc/passwd' },
          { record: {}, codeRef: 'deadbeef.tsx' },
          ENTRY,
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.blueprints).toEqual([ENTRY]);
      expect(parsed.issues).toEqual([
        'invalid code reference ../../etc/passwd; skipping blueprint',
        'invalid code reference deadbeef.tsx; skipping blueprint',
      ]);
    }
  });
});
