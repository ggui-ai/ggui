import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataContract } from '@ggui-ai/protocol';
import { toPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';
import { writePoolArtifact } from './pool-artifact.js';
import { buildBlueprintPushPayload, parsePushFlags } from './push-command.js';

const contract: DataContract = {
  propsSpec: {
    properties: {
      title: { schema: { type: 'string' } },
    },
  },
};

const CODE = `
import React from 'react';
export default function MyComp({ title }: { title: string }) {
  return <div>{title}</div>;
}
`.trim();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ggui-push-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parsePushFlags', () => {
  it('returns empty object when no flags given', () => {
    expect(parsePushFlags([])).toEqual({});
  });

  it('parses --app flag', () => {
    expect(parsePushFlags(['--app', 'my-app-id'])).toEqual({ appId: 'my-app-id' });
  });

  it('parses --from flag', () => {
    expect(parsePushFlags(['--from', '/some/dir'])).toEqual({ from: '/some/dir' });
  });

  it('parses both --app and --from together', () => {
    expect(parsePushFlags(['--app', 'abc', '--from', '/dir'])).toEqual({
      appId: 'abc',
      from: '/dir',
    });
  });

  it('returns error for unknown flag', () => {
    const result = parsePushFlags(['--unknown']);
    expect(result.error).toBeDefined();
  });

  it('returns error when --app has no value', () => {
    const result = parsePushFlags(['--app']);
    expect(result.error).toBeDefined();
  });
});

describe('buildBlueprintPushPayload', () => {
  it('builds one push record per blueprint with required fields', async () => {
    const record = toPortableBlueprint({ contract, componentCode: CODE, variance: {} });
    await writePoolArtifact(dir, [record]);

    const payload = await buildBlueprintPushPayload(dir);

    expect(payload).toHaveLength(1);
    const r = payload[0];
    expect(r).toBeDefined();
    // artifactId must be deterministic: contractHash-variantKey (full, no truncation)
    expect(r!.artifactId).toBe(`${record.contractHash}-${record.variantKey}`);
    expect(r!.artifactId).toContain(record.contractHash);
    expect(r!.artifactId).toContain(record.variantKey);
    // compiledBytes must be non-empty JS output from esbuild
    expect(typeof r!.compiledBytes).toBe('string');
    expect(r!.compiledBytes.length).toBeGreaterThan(0);
    // manifest must carry the contract
    expect(r!.manifest.contract).toBeDefined();
    // version is always '1'
    expect(r!.version).toBe('1');
  });

  it('artifactId encodes both contractHash and variantKey without truncation', async () => {
    const record = toPortableBlueprint({ contract, componentCode: CODE, variance: {} });
    await writePoolArtifact(dir, [record]);

    const payload = await buildBlueprintPushPayload(dir);
    const r = payload[0]!;

    // contractHash is 16 hex chars, variantKey is also 16 hex chars
    // artifactId = "<16chars>-<16chars>" = 33 chars minimum
    expect(r.artifactId.length).toBeGreaterThanOrEqual(33);
    expect(r.artifactId).toMatch(/^[0-9a-f]+-[0-9a-f]+$/);
  });

  it('returns empty array when artifact has no records', async () => {
    // Write an artifact with zero records
    await writePoolArtifact(dir, []);

    const payload = await buildBlueprintPushPayload(dir);
    expect(payload).toHaveLength(0);
  });
});
