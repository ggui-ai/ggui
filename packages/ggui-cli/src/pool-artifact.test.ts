import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
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
  variance: {},
});

const rec2 = toPortableBlueprint({
  contract: { propsSpec: { properties: { y: { schema: { type: 'number' } } } } },
  componentCode: 'export default () => 42;',
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

  it('round-trips two records — both survive', async () => {
    await writePoolArtifact(dir, [rec, rec2]);
    const { records, issues } = await readPoolArtifact(dir);
    expect(issues).toEqual([]);
    expect(records).toHaveLength(2);
    const byHash = new Map(records.map((r) => [r.contractHash, r.componentCode]));
    expect(byHash.get(rec.contractHash)).toBe(rec.componentCode);
    expect(byHash.get(rec2.contractHash)).toBe(rec2.componentCode);
  });

  it('rejects an adversarial codeRef without reading outside codes/', async () => {
    // A sentinel file the manifest tries to escape into; if the codec honoured
    // the traversal we would see its contents surface as a component body.
    const secret = 'export default () => "SHOULD_NOT_BE_READ";';
    await writeFile(join(dir, 'escape.tsx'), secret, 'utf-8');
    await mkdir(join(dir, 'codes'), { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        blueprints: [{ record: { ...rec, componentCode: undefined }, codeRef: '../escape.tsx' }],
      }),
    );
    const { records, issues } = await readPoolArtifact(dir);
    expect(records).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/invalid code reference/i);
    // Prove the escape target was never surfaced into a record.
    expect(records.some((r) => r.componentCode === secret)).toBe(false);
  });

  it('rejects a versioned manifest missing the blueprints array', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1 }));
    await expect(readPoolArtifact(dir)).rejects.toThrow(/blueprints/i);
  });

  it('round-trips non-ASCII + multi-line component code byte-for-byte', async () => {
    const tricky = '// café ☕ 日本語 𝕌𝕟𝕚𝕔𝕠𝕕𝕖\nexport default () => "→\t\r\n←";\n';
    const utfRec = toPortableBlueprint({
      contract: { propsSpec: { properties: { z: { schema: { type: 'string' } } } } },
      componentCode: tricky,
      variance: {},
    });
    await writePoolArtifact(dir, [utfRec]);
    const { records, issues } = await readPoolArtifact(dir);
    expect(issues).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]!.componentCode).toBe(tricky);
    // The on-disk body is the exact bytes too (no normalisation by the codec).
    const bodyFiles = await readdir(join(dir, 'codes'));
    expect(bodyFiles).toHaveLength(1);
    const onDisk = await readFile(join(dir, 'codes', bodyFiles[0]!), 'utf-8');
    expect(onDisk).toBe(tricky);
  });
});
