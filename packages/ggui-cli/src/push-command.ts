import { writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build as esbuild } from 'esbuild';
import { SANDBOX_EXTERNALS } from '@ggui-ai/dev-stack';
import type { DataContract } from '@ggui-ai/protocol';
import { readPoolArtifact } from './pool-artifact.js';
import { findGguiJson, readGguiJson } from './internal/ggui-json.js';
import { exportLocalPool } from './export-pool-command.js';
import { pushAppBlueprints } from './api-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** One entry in the push payload accepted by POST /v1/apps/{appId}/blueprints. */
export interface PushRecord {
  /** `${contractHash}-${variantKey}` — deterministic, no truncation → idempotent re-push. */
  readonly artifactId: string;
  /** Schema version for the blueprint format (always '1'). */
  readonly version: '1';
  readonly manifest: {
    readonly contract: DataContract;
    readonly description?: string;
  };
  /** Compiled ESM JS, ready for the pod to evaluate directly (no pod-side esbuild). */
  readonly compiledBytes: string;
}

export interface ParsedPushFlags {
  readonly appId?: string;
  readonly from?: string;
  readonly error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flag parsing
// ─────────────────────────────────────────────────────────────────────────────

export function parsePushFlags(args: readonly string[]): ParsedPushFlags {
  let appId: string | undefined;
  let from: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--app') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) {
        return { error: '--app requires a value' };
      }
      appId = v;
      i += 1;
    } else if (a === '--from') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) {
        return { error: '--from requires a path' };
      }
      from = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      return { error: '__help__' };
    } else {
      return { error: `unknown flag: ${String(a)}` };
    }
  }

  return {
    ...(appId !== undefined ? { appId } : {}),
    ...(from !== undefined ? { from } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compile TSX → ESM JS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compile a TSX source string to an ESM JS string using esbuild.
 *
 * The compiled output is browser-targeted ESM with the same external set
 * the dev-stack sandbox compiler uses (`SANDBOX_EXTERNALS` — React family
 * + `@ggui-ai/{design,wire,react}`), so stored blueprint code that imports
 * any of those resolves against the iframe runtime's shared instances
 * instead of getting bundled (which would risk a second React copy).
 * esbuild writes to a temp file because the `.tsx` extension drives the
 * right JSX loader (stdin mode wouldn't).
 */
export async function compileTsx(code: string): Promise<string> {
  const tmpFile = join(tmpdir(), `ggui-push-${randomUUID()}.tsx`);
  try {
    await writeFile(tmpFile, code, 'utf-8');
    const result = await esbuild({
      entryPoints: [tmpFile],
      bundle: true,
      format: 'esm',
      target: 'es2020',
      jsx: 'automatic',
      jsxImportSource: 'react',
      platform: 'browser',
      minify: false,
      write: false,
      external: SANDBOX_EXTERNALS,
      logLevel: 'silent',
    });
    if (result.outputFiles.length !== 1) {
      throw new Error(
        `esbuild produced ${result.outputFiles.length} output files; expected 1`,
      );
    }
    return result.outputFiles[0].text;
  } finally {
    await rm(tmpFile, { force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a pool artifact from `artifactDir` and compile each blueprint's
 * component code to ESM JS, returning push-ready records.
 *
 * Returns an empty array if the artifact contains no records (the caller
 * should treat this as "nothing to push").
 */
export async function buildBlueprintPushPayload(artifactDir: string): Promise<PushRecord[]> {
  const { records } = await readPoolArtifact(artifactDir);
  const payload: PushRecord[] = [];
  for (const r of records) {
    const compiledBytes = await compileTsx(r.componentCode);
    // Full artifactId: contractHash-variantKey (no truncation — different
    // variantKeys on the same contractHash would collide on a prefix).
    const artifactId = `${r.contractHash}-${r.variantKey}`;
    payload.push({
      artifactId,
      version: '1',
      manifest: {
        contract: r.contract,
        ...(r.variance.seedPrompt !== undefined
          ? { description: r.variance.seedPrompt }
          : {}),
      },
      compiledBytes,
    });
  }
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command runner
// ─────────────────────────────────────────────────────────────────────────────

export const PUSH_HELP = `ggui push — compile + bulk-push this deployment's blueprints to a cloud app

Exports the local blueprint pool, compiles each blueprint's component code
to ESM JS, and uploads them to the given ggui.ai app.

Usage:
  ggui push [--app <appId>] [--from <poolDir>]

Options:
  --app <appId>   Target app ID. Defaults to ggui.json#appId.
  --from <dir>    Read blueprints from an existing pool artifact directory
                  (created by \`ggui export-pool\`). When omitted, the pool
                  is exported on the fly from the local vectors store.

Requires authentication: run \`ggui login\` first.
`;

export async function runPushCommand(args: readonly string[]): Promise<number> {
  const flags = parsePushFlags(args);
  if (flags.error === '__help__') { process.stdout.write(PUSH_HELP); return 0; }
  if (flags.error) { process.stderr.write(`ggui push: ${flags.error}\n`); return 1; }

  // Resolve appId: --app flag > ggui.json#appId
  let appId = flags.appId;
  if (appId === undefined) {
    const jsonPath = findGguiJson(process.cwd());
    if (jsonPath) {
      const result = readGguiJson(jsonPath);
      if ('value' in result) {
        const val = result.value['appId'];
        if (typeof val === 'string' && val.length > 0) {
          appId = val;
        }
      }
    }
  }
  if (appId === undefined) {
    process.stderr.write(
      'ggui push: no app ID. Pass --app <appId> or set appId in ggui.json.\n',
    );
    return 2;
  }

  // Resolve artifact directory: --from flag or on-the-fly export.
  // The on-the-fly export does NOT error on an empty pool (it writes an
  // empty artifact dir); the empty case is handled gracefully below after
  // the payload build, so `ggui push` on an empty pool exits 0 with
  // "nothing to push." rather than failing.
  let artifactDir: string;
  if (flags.from !== undefined) {
    artifactDir = flags.from;
  } else {
    try {
      // exportLocalPool creates a temp dir when no outDir is given.
      const exported = await exportLocalPool();
      artifactDir = exported.dir;
    } catch (err) {
      process.stderr.write(
        `ggui push: export failed — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  // Build the push payload (compile all TSX → ESM)
  let records: PushRecord[];
  try {
    records = await buildBlueprintPushPayload(artifactDir);
  } catch (err) {
    process.stderr.write(
      `ggui push: failed to build payload — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  if (records.length === 0) {
    process.stdout.write('ggui push: nothing to push.\n');
    return 0;
  }

  // Push to the cloud
  let result: Awaited<ReturnType<typeof pushAppBlueprints>>;
  try {
    result = await pushAppBlueprints(appId, records);
  } catch (err) {
    process.stderr.write(
      `ggui push: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stdout.write(`Pushed ${result.pushed} blueprint(s) to app ${result.appId}.\n`);
  return 0;
}
