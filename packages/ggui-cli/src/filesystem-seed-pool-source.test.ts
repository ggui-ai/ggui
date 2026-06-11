import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemSeedPoolSource } from './filesystem-seed-pool-source.js';
import { writePoolArtifact } from './pool-artifact.js';
import { toPortableBlueprint, fromPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ggui-src-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('FileSystemSeedPoolSource', () => {
  it('loads records from a directory and labels itself by path', async () => {
    const rec = toPortableBlueprint({
      contract: { propsSpec: { properties: {} } },
      componentCode: 'export default () => null;',
      variance: {},
      source: { kind: 'user' },
    });
    await writePoolArtifact(dir, [rec]);
    const source = new FileSystemSeedPoolSource(dir);
    const loaded = await source.loadAll();
    expect(loaded).toHaveLength(1);
    // Records come back raw — narrow through the real trust boundary.
    const parsed = fromPortableBlueprint(loaded[0]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.record.contractHash).toBe(rec.contractHash);
      expect(parsed.record.source).toEqual({ kind: 'user' });
    }
    expect(source.label).toContain(dir);
  });

  it('warns (operator-visible) and skips a record whose code body is missing', async () => {
    const rec = toPortableBlueprint({
      contract: { propsSpec: { properties: {} } },
      componentCode: 'export default () => null;',
      variance: {},
      source: { kind: 'user' },
    });
    await writePoolArtifact(dir, [rec]);
    // Drop the code body so readPoolArtifact yields one issue + zero records.
    await rm(join(dir, 'codes'), { recursive: true, force: true });
    await mkdir(join(dir, 'codes'), { recursive: true });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loaded = await new FileSystemSeedPoolSource(dir).loadAll();
      expect(loaded).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('[ggui]'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
