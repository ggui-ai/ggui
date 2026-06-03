import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemBlueprintSource } from './filesystem-blueprint-source.js';
import { writePoolArtifact } from './pool-artifact.js';
import { toPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ggui-src-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('FileSystemBlueprintSource', () => {
  it('loads records from a directory and labels itself by path', async () => {
    const rec = toPortableBlueprint({
      contract: { propsSpec: { properties: {} } },
      componentCode: 'export default () => null;',
      generator: 'g',
      variance: {},
    });
    await writePoolArtifact(dir, [rec]);
    const source = new FileSystemBlueprintSource(dir);
    const loaded = await source.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.contractHash).toBe(rec.contractHash);
    expect(source.label).toContain(dir);
  });
});
