import { dirname, resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listRegistryBlueprintsForExport,
  type ExportableBlueprint,
} from '@ggui-ai/mcp-server-handlers';
import { toPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';
import { resolveStorageFromConfig, DEFAULT_BUILDER_APP_ID } from '@ggui-ai/mcp-server';
import {
  findGguiJson,
  safeLoadGguiJson,
  type GguiJsonV1,
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

/**
 * Resolve the storage stack → list blueprints → write a pool artifact to disk.
 *
 * When `outDir` is omitted a fresh temp directory is created (suitable for
 * a subsequent `ggui push` that immediately reads the artifact). When provided,
 * the artifact is written to `resolve(process.cwd(), outDir)`.
 *
 * Throws on hard errors (no vectors store, list failure).
 * Returns the absolute path of the written artifact directory.
 */
export async function exportLocalPool(outDir?: string): Promise<string> {
  // Resolve the SAME storage stack `ggui serve` uses, from ggui.json in cwd.
  // A missing manifest is fine (MCP-only / default storage); a manifest that
  // exists but fails schema validation is a hard error — surface it rather
  // than silently falling through to the generic "no vectors store" message.
  const gguiJsonPath = findGguiJson(process.cwd());
  let manifest: GguiJsonV1 | undefined;
  if (gguiJsonPath) {
    const loaded = safeLoadGguiJson(gguiJsonPath);
    if (!loaded.success) {
      throw new Error(loaded.error.message);
    }
    manifest = loaded.data;
  }
  const projectRoot = gguiJsonPath ? dirname(gguiJsonPath) : process.cwd();
  const storage = await resolveStorageFromConfig(manifest?.storage, { baseDir: projectRoot });
  if (!storage.vectors) {
    throw new Error(
      'no persistent vectors store. Set storage.vectors.driver="sqlite" in ggui.json (nothing to export from an in-memory store).',
    );
  }

  const rows: readonly ExportableBlueprint[] =
    await listRegistryBlueprintsForExport(storage.vectors, DEFAULT_BUILDER_APP_ID);
  if (rows.length === 0) {
    throw new Error('0 blueprints found for this app; nothing to export.');
  }

  // Tool-identity catalog is NOT available here: `export-pool` is a
  // batch offline export with no live MCP connections. The catalog is
  // a runtime artifact built from active `initialize` + `tools/list`
  // handshakes during `ggui serve`. Passing it here would require
  // either persisting it to disk or starting the server just for export
  // — both are the wrong trade-off for an offline command. The
  // `generatorProtocolVersion` stamp (always set by toPortableBlueprint)
  // is sufficient for era-compatibility gating; the `toolIdentityCatalogHash`
  // remains absent, triggering an "unstamped → warn" policy on importers.
  const records = rows.map((r) => toPortableBlueprint(r));

  const resolvedDir = outDir !== undefined
    ? resolve(process.cwd(), outDir)
    : await mkdtemp(join(tmpdir(), 'ggui-pool-'));

  await writePoolArtifact(resolvedDir, records);
  return resolvedDir;
}

export async function runExportPoolCommand(args: readonly string[]): Promise<number> {
  const flags = parseExportPoolFlags(args);
  if (flags.error === '__help__') { process.stdout.write(EXPORT_POOL_HELP); return 0; }
  if (flags.error) { process.stderr.write(`ggui export-pool: ${flags.error}\n`); return 1; }

  let outDir: string;
  try {
    outDir = await exportLocalPool(flags.out);
  } catch (err) {
    process.stderr.write(`ggui export-pool: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  process.stdout.write(`ggui export-pool: wrote blueprints to ${outDir}\n`);
  return 0;
}
