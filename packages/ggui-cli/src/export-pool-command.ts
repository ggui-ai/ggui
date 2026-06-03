import { dirname, resolve } from 'node:path';
import {
  listRegistryBlueprintsForExport,
  type ExportableBlueprint,
} from '@ggui-ai/mcp-server-handlers';
import { toPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';
import { resolveStorageFromConfig, DEFAULT_BUILDER_APP_ID } from '@ggui-ai/mcp-server';
import {
  findGguiJson,
  safeLoadGguiJson,
} from '@ggui-ai/project-config/node';
import { writePoolArtifact } from './pool-artifact.js';

interface ExportPoolFlags { out: string; error?: string; }

function parseExportPoolFlags(args: readonly string[]): ExportPoolFlags {
  let out = './ggui-pool';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out' || a === '-o') {
      const v = args[++i];
      if (v === undefined) return { out, error: '--out requires a path' };
      out = v;
    } else if (a === '--help' || a === '-h') {
      return { out, error: '__help__' };
    }
  }
  return { out };
}

export const EXPORT_POOL_HELP = `ggui export-pool — export this app's reusable blueprints as a shared pool

Writes a directory artifact (manifest.json + codes/) that another ggui
deployment can load with \`ggui serve --seed-pool <dir>\`.

Usage:
  ggui export-pool [--out <dir>]

Options:
  --out <dir>   Output directory (default: ./ggui-pool).

Requires a persistent vectors store (ggui.json: storage.vectors.driver = "sqlite").
`;

export async function runExportPoolCommand(args: readonly string[]): Promise<number> {
  const flags = parseExportPoolFlags(args);
  if (flags.error === '__help__') { process.stdout.write(EXPORT_POOL_HELP); return 0; }
  if (flags.error) { process.stderr.write(`ggui export-pool: ${flags.error}\n`); return 1; }

  // Resolve the SAME storage stack `ggui serve` uses, from ggui.json in cwd.
  const gguiJsonPath = findGguiJson(process.cwd());
  const manifest = gguiJsonPath
    ? (() => {
        const loaded = safeLoadGguiJson(gguiJsonPath);
        return loaded.success ? loaded.data : undefined;
      })()
    : undefined;
  const projectRoot = gguiJsonPath ? dirname(gguiJsonPath) : process.cwd();
  const storage = await resolveStorageFromConfig(manifest?.storage, { baseDir: projectRoot });
  if (!storage.vectors) {
    process.stderr.write(
      'ggui export-pool: no persistent vectors store. Set storage.vectors.driver="sqlite" in ggui.json (nothing to export from an in-memory store).\n',
    );
    return 1;
  }

  let rows: readonly ExportableBlueprint[];
  try {
    rows = await listRegistryBlueprintsForExport(storage.vectors, DEFAULT_BUILDER_APP_ID);
  } catch (err) {
    process.stderr.write(`ggui export-pool: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (rows.length === 0) {
    process.stderr.write('ggui export-pool: 0 blueprints found for this app; nothing written.\n');
    return 1;
  }

  const records = rows.map((r) => toPortableBlueprint(r));
  const outDir = resolve(process.cwd(), flags.out);
  await writePoolArtifact(outDir, records);
  process.stdout.write(`ggui export-pool: wrote ${records.length} blueprint(s) to ${outDir}\n`);
  return 0;
}
