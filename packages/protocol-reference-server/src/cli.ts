#!/usr/bin/env node
/**
 * `ggui-protocol-reference-server` — CLI entry.
 *
 * Usage:
 *
 *     npx @ggui-ai/protocol-reference-server --port 3100
 *
 * Prints `READY ws://host:port/ws` to stdout when bound. Runs
 * indefinitely; Ctrl-C to stop.
 *
 * This is the manual smoke-check entry. For programmatic use (the
 * conformance CI test, third-party integration tests), import
 * `ReferenceServer` + `createReferenceConformanceHost` directly.
 */
import { ReferenceServer } from './server.js';

interface ParsedArgs {
  readonly port: number;
  readonly host: string;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let port = 3100;
  let host = '127.0.0.1';
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
      case '--port':
        port = Number.parseInt(next(), 10);
        if (Number.isNaN(port)) throw new Error('--port must be an integer');
        break;
      case '--host':
        host = next();
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`unknown flag '${flag}' — run with --help for usage`);
    }
  }

  return { port, host, help };
}

const USAGE = `
ggui-protocol-reference-server — minimal ggui protocol reference implementation

Usage:
  ggui-protocol-reference-server [--port <N>] [--host <H>]

Options:
  --port <N>        Port to bind. Default 3100.
  --host <H>        Host interface. Default 127.0.0.1.
  --help, -h        Show this help.

Scope: narrow WS server implementing the ggui live-channel wire.
Used by @ggui-ai/protocol-conformance to prove the protocol is vendor-neutral.
NOT a production server — no auth, no persistence.
`.trimStart();

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${String((err as Error).message ?? err)}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const server = new ReferenceServer({ port: parsed.port, host: parsed.host });
  await server.start();
  process.stdout.write(`READY ws://${parsed.host}:${server.port}/ws\n`);

  // Keep the process alive until SIGINT/SIGTERM.
  await new Promise<void>((done) => {
    const shutdown = (): void => {
      void server.stop().then(done);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return 0;
}

function isEntryPoint(): boolean {
  if (typeof import.meta.url !== 'string') return false;
  const scriptPath = process.argv[1];
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) return false;
  try {
    return import.meta.url === new URL(`file://${scriptPath}`).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${String((err as Error).message ?? err)}\n`);
      process.exit(2);
    },
  );
}

export { main, parseArgs };
