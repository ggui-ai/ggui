#!/usr/bin/env node
/**
 * `ggui-protocol-conformance` — CLI entry point.
 *
 * Usage:
 *
 *     npx @ggui-ai/protocol-conformance \
 *       --url http://localhost:3000 \
 *       --auth bearer:TOKEN
 *
 * Exits 0 only when at least one fixture executed AND none failed.
 * Exits 1 if ANY fixture failed. Exits 2 on invocation errors AND
 * when the run executed zero fixtures (everything skipped) — a
 * conformance run that proved nothing must not read as success in
 * CI. Individual skips are still not failures — an implementation
 * may legitimately not provide every `ConformanceHost` directive in
 * v1.0 — but a run that is ALL skips carries no signal.
 *
 * The three PURE-FUNCTION catalogs (refusal-envelope,
 * registry-completeness, transport-refusal) grade an in-process
 * function and a data table, not the wire: `--registry <file.json>`,
 * `--projector <module>` and `--transport-projector <module>` hand
 * them their inputs (ggui#803 leg 3). A flag left out leaves its
 * catalog SKIPPED with the flag named, never silently absent. Catalog
 * rows count as executed fixtures, so a run given a catalog flag can
 * exit 0 while every wire fixture is SKIPPED — read the scorecard,
 * not only the exit code, for a wire signal.
 *
 * Honest scope of the bundled CLI: no `host` wiring. The CLI runs
 * the runner with an absent host, meaning every fixture with non-empty
 * `setup` skips cleanly with the "no host provided" reason — and
 * since every fixture in the current catalog declares setup, a
 * hostless CLI run with no catalog flag skips them all and exits 2 by
 * design. To get real pass/fail signal against an implementation,
 * consumers call `runConformance({ host: myImpl })` programmatically
 * and apply the same guard:
 * `result.failed.length > 0 || result.passed.length === 0` is a red
 * build. The CLI remains the lowest-friction wire-level smoke check
 * for setups where the server under test is provisioned out-of-band
 * rather than through a `ConformanceHost` injection.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  PreGenerationRefusalInput,
  ProjectedRefusalResult,
} from './refusal-envelope-conformance/index.js';
import type {
  RefusalRegistryRow,
  RefusalRegistryView,
} from './registry-completeness/index.js';
import { createDefaultReporter, formatFailures, formatSkips } from './reporter.js';
import {
  runConformance,
  type ConformanceResult,
  type RunConformanceConfig,
} from './run-conformance.js';
import type {
  ProjectedTransportRefusal,
  TransportRefusalInput,
} from './transport-refusal-conformance/index.js';
import type { AuthConfig } from './types.js';

// =============================================================================
// Arg parser (hand-rolled — no dep)
// =============================================================================

interface ParsedArgs {
  readonly url?: string;
  readonly auth?: string;
  readonly only?: readonly string[];
  readonly timeoutMs?: number;
  /** Path to a JSON file holding the deployment's refusal registry (code → row). */
  readonly registry?: string;
  /** Path to an ES module exporting the SPEC §7.1 refusal projector. */
  readonly projector?: string;
  /** Path to an ES module exporting the endpoint-level refusal projector. */
  readonly transportProjector?: string;
  readonly verbose: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let url: string | undefined;
  let auth: string | undefined;
  const only: string[] = [];
  let timeoutMs: number | undefined;
  let registry: string | undefined;
  let projector: string | undefined;
  let transportProjector: string | undefined;
  let verbose = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for '${flag}'`);
      }
      i += 1;
      return value;
    };
    switch (flag) {
      case '--url':
        url = next();
        break;
      case '--auth':
        auth = next();
        break;
      case '--only':
        only.push(next());
        break;
      case '--timeout-ms':
        timeoutMs = Number.parseInt(next(), 10);
        if (Number.isNaN(timeoutMs)) throw new Error('--timeout-ms must be an integer');
        break;
      case '--registry':
        registry = next();
        break;
      case '--projector':
        projector = next();
        break;
      case '--transport-projector':
        transportProjector = next();
        break;
      case '--verbose':
      case '-v':
        verbose = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`unknown flag '${flag}' — run with --help for usage`);
    }
  }

  return { url, auth, only, timeoutMs, registry, projector, transportProjector, verbose, help };
}

/** The message of a thrown value, without pretending every throw is an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseAuth(spec: string): AuthConfig {
  const idx = spec.indexOf(':');
  if (idx === -1) {
    throw new Error(`--auth expects 'kind:value'; received '${spec}'`);
  }
  const kind = spec.slice(0, idx);
  const value = spec.slice(idx + 1);
  if (kind === 'bearer') return { kind: 'bearer', token: value };
  if (kind === 'session-cookie') return { kind: 'session-cookie', cookie: value };
  throw new Error(
    `--auth kind '${kind}' is not recognized; supported: 'bearer', 'session-cookie'`,
  );
}

// =============================================================================
// Pure-function catalog inputs (ggui#803 leg 3)
// =============================================================================

/** The three optional inputs a CLI run can hand the pure-function catalogs. */
export type CatalogInputs = Pick<
  RunConformanceConfig,
  'refusalRegistry' | 'refusalProjector' | 'transportRefusalProjector'
>;

/** The flag values that name where each catalog input comes from. */
export interface CatalogInputPaths {
  readonly registry?: string | undefined;
  readonly projector?: string | undefined;
  readonly transportProjector?: string | undefined;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * The runtime twin of {@link RefusalRegistryRow} — a JSON registry is
 * held to exactly the shape a programmatic caller has to satisfy at
 * compile time. Value-level rules (recognized retry class, `fixBy` on
 * `after-fix`, code equals key, non-empty surfaces) are NOT checked
 * here: those are the registry-completeness catalog's pins, and a
 * deliberately broken registry must stay expressible so they can
 * grade it.
 */
function isRegistryRow(value: unknown): value is RefusalRegistryRow {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    isStringArray(value.surfaces) &&
    typeof value.retry === 'string' &&
    (value.fixBy === undefined || typeof value.fixBy === 'string') &&
    typeof value.emitter === 'string' &&
    typeof value.description === 'string'
  );
}

function parseRegistryView(text: string, path: string): RefusalRegistryView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--registry ${path} is not JSON: ${errorMessage(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`--registry ${path} must be a JSON object of rows keyed by code`);
  }
  const rows: Array<readonly [string, RefusalRegistryRow]> = [];
  for (const [code, row] of Object.entries(parsed)) {
    if (!isRegistryRow(row)) {
      throw new Error(
        `--registry ${path}: row '${code}' is not a registry row (needs string code, string[] surfaces, string retry, string emitter, string description, optional string fixBy)`,
      );
    }
    rows.push([code, row]);
  }
  // fromEntries defines OWN properties — a row keyed `__proto__` stays a row.
  return Object.fromEntries(rows);
}

function isRefusalInput(value: unknown): value is PreGenerationRefusalInput {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.fix === 'string' &&
    typeof value.retry === 'string' &&
    typeof value.handshake === 'string' &&
    (value.balanceCentsAtCheck === undefined || typeof value.balanceCentsAtCheck === 'number')
  );
}

function isProjectedRefusalResult(value: unknown): value is ProjectedRefusalResult {
  return (
    isRecord(value) &&
    typeof value.isError === 'boolean' &&
    typeof value.text === 'string' &&
    isRecord(value.structuredContent) &&
    typeof value.structuredContent.outcome === 'string' &&
    isRefusalInput(value.structuredContent.refusal) &&
    typeof value.hasMeta === 'boolean' &&
    isStringArray(value.identityFields)
  );
}

function isTransportRefusalInput(value: unknown): value is TransportRefusalInput {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.fix === 'string' &&
    typeof value.retry === 'string'
  );
}

function isProjectedTransportRefusal(value: unknown): value is ProjectedTransportRefusal {
  return (
    isRecord(value) &&
    typeof value.httpStatus === 'number' &&
    isRecord(value.error) &&
    typeof value.error.code === 'number' &&
    typeof value.error.message === 'string' &&
    isRecord(value.error.data) &&
    isTransportRefusalInput(value.error.data.refusal)
  );
}

/**
 * Import an ES module at `path` (resolved against the working
 * directory) and return the projector it exports —
 * `export function project(...)` or the default export. The module is
 * an external boundary: its export is checked to be a function here,
 * and every value it returns is checked against the projection shape
 * by `guard` before the catalog sees it, so a module that returns the
 * wrong shape fails by flag name instead of typing its way into a
 * grade. The catalogs grade that throw as a FAIL on the case in hand
 * and keep grading the rest — never a crash of the run.
 */
async function loadProjector<I, O>(
  flag: string,
  path: string,
  guard: (value: unknown) => value is O,
): Promise<(input: I) => O | null> {
  const href = pathToFileURL(resolve(path)).href;
  let mod: { readonly project?: unknown; readonly default?: unknown };
  try {
    mod = await import(/* @vite-ignore */ href);
  } catch (err) {
    throw new Error(`${flag} ${path} could not be imported: ${errorMessage(err)}`);
  }
  const candidate: unknown = mod.project ?? mod.default;
  if (typeof candidate !== 'function') {
    throw new Error(`${flag} ${path} must export \`project\` (or a default export) as a function`);
  }
  return (input: I): O | null => {
    const out: unknown = candidate(input);
    if (out === null) return null;
    if (!guard(out)) {
      throw new Error(
        `${flag} ${path} returned a value that is not a projection: ${JSON.stringify(out)}`,
      );
    }
    return out;
  };
}

/**
 * Resolve the `--registry` / `--projector` / `--transport-projector`
 * flags into the runner's catalog inputs. A flag that is absent yields
 * no input, and the runner reports that catalog SKIPPED with the flag
 * named. Every failure names the flag and the path.
 */
export async function loadCatalogInputs(paths: CatalogInputPaths): Promise<CatalogInputs> {
  const inputs: {
    refusalRegistry?: RefusalRegistryView;
    refusalProjector?: RunConformanceConfig['refusalProjector'];
    transportRefusalProjector?: RunConformanceConfig['transportRefusalProjector'];
  } = {};
  if (paths.registry !== undefined) {
    let text: string;
    try {
      text = await readFile(resolve(paths.registry), 'utf8');
    } catch (err) {
      throw new Error(`--registry ${paths.registry} could not be read: ${errorMessage(err)}`);
    }
    inputs.refusalRegistry = parseRegistryView(text, paths.registry);
  }
  if (paths.projector !== undefined) {
    inputs.refusalProjector = await loadProjector<PreGenerationRefusalInput, ProjectedRefusalResult>(
      '--projector',
      paths.projector,
      isProjectedRefusalResult,
    );
  }
  if (paths.transportProjector !== undefined) {
    inputs.transportRefusalProjector = await loadProjector<
      TransportRefusalInput,
      ProjectedTransportRefusal
    >('--transport-projector', paths.transportProjector, isProjectedTransportRefusal);
  }
  return inputs;
}

// =============================================================================
// Entry point
// =============================================================================

export const USAGE = `
ggui-protocol-conformance — run the protocol conformance kit against a live server

Usage:
  ggui-protocol-conformance --url <URL> --auth <kind:value> [options]

Required:
  --url <URL>              Server URL. A bare origin (http://… or ws://…
                           without a path) gets the default live-channel
                           path /ws appended; a URL that already carries
                           a path (e.g. ws://host:3000/ws) is used as
                           given. http(s) schemes derive ws(s).
  --auth <kind:value>      Auth carried on the WS upgrade.
                             bearer:TOKEN          — Authorization header
                             session-cookie:COOKIE — Cookie header

Options:
  --only <fixture-name>    Run only this fixture. May be repeated. Also
                           filters the pure-function catalog rows, whose
                           names are prefixed <catalog>/<case>.
  --timeout-ms <N>         Per-fixture observation window. Default 2000.
  --registry <file.json>   The deployment's refusal-code registry, a JSON
                           object keyed by code (grades registry-completeness).
  --projector <module>     ES module whose \`project(refusal)\` — a named or
                           default export — returns the SPEC §7.1 tool result
                           for a refusal, or null when the code has no
                           envelope on the render-gate surface (grades
                           refusal-envelope).
  --transport-projector <module>
                           ES module whose \`project(refusal)\` — named or
                           default export — returns the endpoint's
                           { httpStatus, error } for a refusal, or null when
                           the code has no transport envelope (grades
                           transport-refusal).
  --verbose, -v            Print failure details + skip reasons at the end.
  --help, -h               Show this help.

Pure-function catalogs (refusal-envelope, registry-completeness, transport-refusal):
  These grade an in-process function and a data table, not the wire, so
  a URL alone cannot reach them: the three flags above hand them their
  inputs. A flag left out leaves its catalog on the scorecard as SKIPPED
  with the flag named — an ungraded obligation stays visible rather
  than vanishing. File and module paths resolve against the working
  directory. A projector must be synchronous; one that throws, returns
  undefined, or returns a non-projection is graded as a FAIL on that
  case (exit 1) and the remaining cases are still graded — never a
  crash. Catalog rows count as executed fixtures: a run given a
  catalog flag can exit 0 while every wire fixture is SKIPPED, so read
  the scorecard, not only the exit code, for a wire signal.

Exit codes:
  0  — at least one fixture executed and none failed.
  1  — at least one fixture failed.
  2  — invocation error (bad args, unreadable registry or projector,
       cannot reach server, etc.), or the run executed zero fixtures
       (every fixture skipped) — a run that proved nothing never reads
       as success.
`.trimStart();

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${errorMessage(err)}\n\n`);
    process.stderr.write(USAGE);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (parsed.url === undefined) {
    process.stderr.write('error: --url is required\n\n');
    process.stderr.write(USAGE);
    return 2;
  }
  if (parsed.auth === undefined) {
    process.stderr.write('error: --auth is required\n\n');
    process.stderr.write(USAGE);
    return 2;
  }

  let auth: AuthConfig;
  try {
    auth = parseAuth(parsed.auth);
  } catch (err) {
    process.stderr.write(`error: ${errorMessage(err)}\n\n`);
    process.stderr.write(USAGE);
    return 2;
  }

  let catalogInputs: CatalogInputs;
  try {
    catalogInputs = await loadCatalogInputs(parsed);
  } catch (err) {
    process.stderr.write(`error: ${errorMessage(err)}\n\n`);
    process.stderr.write(USAGE);
    return 2;
  }

  const reporter = createDefaultReporter();
  const result = await runConformance({
    serverUrl: parsed.url,
    auth,
    only: parsed.only !== undefined && parsed.only.length > 0 ? parsed.only : undefined,
    observationTimeoutMs: parsed.timeoutMs,
    reporter,
    ...catalogInputs,
  });

  if (parsed.verbose) {
    const failures = formatFailures(result.failed);
    if (failures.length > 0) process.stdout.write(`${failures}\n`);
    const skips = formatSkips(result.skipped);
    if (skips.length > 0) process.stdout.write(`${skips}\n`);
  }

  const code = exitCodeForResult(result);
  if (code === 2) {
    process.stderr.write(
      `error: conformance run executed ZERO fixtures (0 passed, ${result.failed.length} failed, ${result.skipped.length} skipped) — an all-skip run proves nothing and must not read as success; exiting 2. Run with --verbose for skip reasons.\n`,
    );
  }
  return code;
}

/**
 * Map a {@link ConformanceResult} to the CLI exit code:
 *   - `1` — at least one fixture failed.
 *   - `2` — zero fixtures executed (every fixture skipped). A run
 *     that graded nothing carries no conformance signal and must not
 *     read as success in CI.
 *   - `0` — at least one fixture executed and none failed.
 */
function exitCodeForResult(result: ConformanceResult): 0 | 1 | 2 {
  if (result.failed.length > 0) return 1;
  if (result.passed.length === 0) return 2;
  return 0;
}

// Immediately-invoked — this module IS the bin entry. Tests import
// `parseArgs` / `parseAuth` / `loadCatalogInputs` / `exitCodeForResult`
// / `main` via named exports without triggering the run.
if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${errorMessage(err)}\n`);
      process.exit(2);
    },
  );
}

function isEntryPoint(): boolean {
  // Node ESM entry-point check. `import.meta.url` equals
  // `pathToFileURL(process.argv[1])` when this module was invoked as
  // the script. Guards against running `main()` when the module is
  // imported (e.g., from meta-tests).
  if (typeof import.meta.url !== 'string') return false;
  const scriptPath = process.argv[1];
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) return false;
  try {
    const scriptUrl = new URL(`file://${scriptPath}`);
    return import.meta.url === scriptUrl.href;
  } catch {
    return false;
  }
}

export { exitCodeForResult, main, parseArgs, parseAuth };
