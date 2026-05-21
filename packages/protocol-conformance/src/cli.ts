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
 * Exits with code 0 if every fixture passed OR skipped; exits 1 if
 * ANY fixture failed. Skips are not failures — an implementation may
 * legitimately not provide every `ConformanceHost` directive in
 * v1.0. Operators who want skip-is-failure semantics can pair
 * `--require-host` (future) with a host that implements every known
 * directive.
 *
 * Honest scope of the bundled CLI: no `host` wiring. The CLI runs
 * the runner with an absent host, meaning every fixture with non-empty
 * `setup` skips cleanly with the "no host provided" reason. To get
 * real pass/fail signal against an implementation, consumers call
 * `runConformance({ host: myImpl })` programmatically. The CLI is the
 * lowest-friction entry point for a smoke check, and for CI jobs where
 * the server under test is exercised directly over the wire via a
 * subprocess harness rather than a `ConformanceHost` injection.
 */
import { createDefaultReporter, formatFailures, formatSkips } from './reporter.js';
import { runConformance } from './run-conformance.js';
import type { AuthConfig } from './types.js';

// =============================================================================
// Arg parser (hand-rolled — no dep)
// =============================================================================

interface ParsedArgs {
  readonly url?: string;
  readonly auth?: string;
  readonly only?: readonly string[];
  readonly timeoutMs?: number;
  readonly verbose: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let url: string | undefined;
  let auth: string | undefined;
  const only: string[] = [];
  let timeoutMs: number | undefined;
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

  return { url, auth, only, timeoutMs, verbose, help };
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
// Entry point
// =============================================================================

const USAGE = `
ggui-protocol-conformance — run the protocol conformance kit against a live server

Usage:
  ggui-protocol-conformance --url <URL> --auth <kind:value> [options]

Required:
  --url <URL>              Base URL of the server (http://… or https://…).
                           The runner derives ws://…/ws from this.
  --auth <kind:value>      Auth carried on the WS upgrade.
                             bearer:TOKEN          — Authorization header
                             session-cookie:COOKIE — Cookie header

Options:
  --only <fixture-name>    Run only this fixture. May be repeated.
  --timeout-ms <N>         Per-fixture observation window. Default 2000.
  --verbose, -v            Print failure details + skip reasons at the end.
  --help, -h               Show this help.

Exit codes:
  0  — all fixtures passed or skipped.
  1  — at least one fixture failed.
  2  — invocation error (bad args, cannot reach server, etc.).
`.trimStart();

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${String((err as Error).message ?? err)}\n\n`);
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
    process.stderr.write(`error: ${String((err as Error).message ?? err)}\n\n`);
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
  });

  if (parsed.verbose) {
    const failures = formatFailures(result.failed);
    if (failures.length > 0) process.stdout.write(`${failures}\n`);
    const skips = formatSkips(result.skipped);
    if (skips.length > 0) process.stdout.write(`${skips}\n`);
  }

  return result.failed.length > 0 ? 1 : 0;
}

// Immediately-invoked — this module IS the bin entry. Tests import
// `parseArgs` / `parseAuth` / `main` via named exports without
// triggering the run.
if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${String((err as Error).message ?? err)}\n`);
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

export { main, parseArgs, parseAuth };
