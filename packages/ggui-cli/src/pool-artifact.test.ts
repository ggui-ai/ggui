import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePoolArtifact, readPoolArtifact } from './pool-artifact.js';
import { toPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ggui-pool-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const rec = toPortableBlueprint({
  contract: { propsSpec: { properties: { x: { schema: { type: 'string' } } } } },
  componentCode: 'export default () => null;',
  generator: 'g',
  variance: {},
});

describe('pool artifact codec', () => {
  it('round-trips records through a directory', async () => {
    await writePoolArtifact(dir, [rec]);
    const { records, issues } = await readPoolArtifact(dir);
    expect(issues).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]!.componentCode).toBe(rec.componentCode);
    expect(records[0]!.contractHash).toBe(rec.contractHash);
  });

  it('reports a missing code body as an issue, not a throw', async () => {
    await writePoolArtifact(dir, [rec]);
    await rm(join(dir, 'codes'), { recursive: true, force: true });
    await mkdir(join(dir, 'codes'), { recursive: true });
    const { records, issues } = await readPoolArtifact(dir);
    expect(records).toHaveLength(0);
    expect(issues[0]).toMatch(/code body/i);
  });

  it('throws on an unknown schemaVersion', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 99, blueprints: [] }));
    await expect(readPoolArtifact(dir)).rejects.toThrow(/schemaVersion/i);
  });
});
