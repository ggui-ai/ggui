import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVectorStore } from '@ggui-ai/mcp-server-core/sqlite';
import { InMemoryBlueprintIndex } from '@ggui-ai/mcp-server-core/in-memory';
import { registerBlueprint } from '@ggui-ai/mcp-server-handlers';
import { DEFAULT_BUILDER_APP_ID } from '@ggui-ai/mcp-server';
import { PROTOCOL_VERSION } from '@ggui-ai/protocol/version';
import { exportLocalPool, runExportPoolCommand } from './export-pool-command.js';

const embedding = { id: 'inert', dimensions: 1, embed: async (): Promise<number[]> => [0] };

const CODE = 'export default function Todo(){ return null }';

let projectDir: string;
let outDir: string;
let origCwd: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ggui-export-proj-'));
  outDir = await mkdtemp(join(tmpdir(), 'ggui-export-out-'));
  origCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(origCwd);
  await rm(projectDir, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Register `count` template blueprints into a sqlite vector store inside
 * `projectDir`, then write a `ggui.json` that points the vectors surface at
 * the same sqlite file. After this, `exportLocalPool` / `runExportPoolCommand`
 * run from `projectDir` will read the same rows.
 */
async function seedProject(count: number): Promise<void> {
  const sqlitePath = join(projectDir, 'vectors.sqlite');
  const vectorStore = new SqliteVectorStore({ filename: sqlitePath });
  const registry = { embedding, vectorStore, index: new InMemoryBlueprintIndex() };
  for (let i = 0; i < count; i++) {
    await registerBlueprint(registry, DEFAULT_BUILDER_APP_ID, {
      kind: 'template',
      // Distinct contract per row so each mints a separate blueprint.
      contract: {
        propsSpec: { properties: { [`field${i}`]: { schema: { type: 'string' } } } },
      },
      intent: `blueprint ${i}`,
      componentCode: CODE,
      provenance: 'register',
      variance: {},
    });
  }
  await writeFile(
    join(projectDir, 'ggui.json'),
    JSON.stringify(
      {
        schema: '1',
        protocol: PROTOCOL_VERSION,
        app: { slug: 'export-pool-test', name: 'Export Pool Test' },
        storage: { vectors: { driver: 'sqlite', path: './vectors.sqlite' } },
      },
      null,
      2,
    ),
    'utf-8',
  );
}

describe('runExportPoolCommand', () => {
  it('writes an artifact to --out and prints the blueprint count', async () => {
    await seedProject(2);
    process.chdir(projectDir);

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });

    const code = await runExportPoolCommand(['--out', outDir]);
    expect(code).toBe(0);

    // The artifact must be written to the --out directory.
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf-8')) as {
      blueprints: unknown[];
    };
    expect(manifest.blueprints).toHaveLength(2);

    // The stdout must include the count (this guards the count-regression).
    const out = writes.join('');
    expect(out).toContain('wrote 2 blueprint(s)');
    expect(out).toContain(outDir);
  });

  it('errors (exit 1) on an empty pool with an explicit export', async () => {
    await seedProject(0);
    process.chdir(projectDir);

    const errs: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      errs.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });

    const code = await runExportPoolCommand(['--out', outDir]);
    expect(code).toBe(1);
    expect(errs.join('')).toContain('0 blueprints found');
  });
});

describe('exportLocalPool', () => {
  it('returns the artifact dir + record count (count > 0)', async () => {
    await seedProject(3);
    process.chdir(projectDir);

    const result = await exportLocalPool(outDir);
    expect(result.dir).toBe(outDir);
    expect(result.count).toBe(3);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
  });

  it('does NOT throw on an empty pool — returns count 0 and still writes the artifact', async () => {
    await seedProject(0);
    process.chdir(projectDir);

    const result = await exportLocalPool(outDir);
    expect(result.count).toBe(0);
    // The artifact directory is written regardless so push can read it.
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
  });
});
