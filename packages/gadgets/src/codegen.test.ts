// `writeDescriptorJson` is the wrapper-author build helper: validate
// descriptors against the strict registry schema and write the `gg2`
// descriptor.json. Gadgets are direct-imported, so a wrapper's type
// narrowing comes from its own real `.d.ts` — there is no
// catalog-augmentation codegen step. The codegen lives at
// `@ggui-ai/gadgets/codegen`.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDescriptorJson } from './codegen';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ggui-descriptor-'));
}

const TYPES_URL = 'https://registry.ggui.ai/types/foo/0.0.1/index.d.ts';

describe('writeDescriptorJson', () => {
  it('validates descriptors and writes the gg2 document', async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, 'descriptor.json');
      const doc = await writeDescriptorJson({
        descriptors: [
          {
            package: '@scope/foo',
            version: '0.0.1',
            typesUrl: TYPES_URL,
            exports: [
              {
                hook: 'useFoo',
                description: 'Foo gadget.',
                usage: 'Mount it.',
                example: { call: 'useFoo()' },
              },
            ],
          },
        ],
        outputPath: path,
      });
      expect(doc.version).toBe('gg2');
      expect(doc.descriptors).toHaveLength(1);
      expect(doc.descriptors[0]?.exports[0]).toMatchObject({
        hook: 'useFoo',
      });

      const onDisk = JSON.parse(await readFile(path, 'utf8')) as unknown;
      expect(onDisk).toEqual(doc);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when a descriptor fails strict registry validation', async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, 'descriptor.json');
      await expect(
        writeDescriptorJson({
          descriptors: [
            {
              package: '@scope/broken',
              version: '0.0.1',
              // Missing required `description` / `usage` / `example`.
              exports: [{ hook: 'useBroken' }],
            },
          ],
          outputPath: path,
        }),
      ).rejects.toThrow(/failed strict validation/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when a non-stdlib descriptor omits typesUrl (strict refinement)', async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, 'descriptor.json');
      await expect(
        writeDescriptorJson({
          descriptors: [
            {
              package: '@scope/foo',
              version: '0.0.1',
              // No typesUrl — the wrapper build must emit a .d.ts.
              exports: [
                {
                  hook: 'useFoo',
                  description: 'Foo gadget.',
                  usage: 'Mount it.',
                  example: { call: 'useFoo()' },
                },
              ],
            },
          ],
          outputPath: path,
        }),
      ).rejects.toThrow(/failed strict validation/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes a JSON document with the `gg2` schema marker', async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, 'descriptor.json');
      await writeDescriptorJson({
        descriptors: [
          {
            package: '@scope/foo',
            version: '0.0.1',
            typesUrl: TYPES_URL,
            exports: [
              {
                hook: 'useFoo',
                description: 'Foo.',
                usage: 'Use.',
                example: {},
              },
            ],
          },
        ],
        outputPath: path,
      });
      const onDisk = JSON.parse(await readFile(path, 'utf8')) as {
        version: string;
      };
      expect(onDisk.version).toBe('gg2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
