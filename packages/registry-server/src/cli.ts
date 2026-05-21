#!/usr/bin/env node
/**
 * `npx @ggui-ai/registry-server` — CLI entry for the OSS registry.
 *
 * Flag reference:
 *
 *   --port=<n>                Default 9001. Use 0 to let the OS assign.
 *   --host=<h>                Default 0.0.0.0.
 *   --storage=fs:<path>       Filesystem mode; `<path>` is the state root.
 *   --storage=memory          In-memory mode; wiped on restart.
 *   --token=<t>               Required if not set via GGUI_REGISTRY_TOKEN env.
 *   --subject=<s>             Optional. Override the verified subject.
 *   --bundle-host=<url>       Required. Public URL prefix for bundles.
 *   --registry-hostname=<h>   Required. Hostname embedded in installCommand.
 *
 * Vendor-neutral help text: "bearer auth" is the only auth scheme this
 * CLI knows about; no specific identity-provider name appears anywhere.
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inMemoryBundleStorage, inMemoryRegistryStorage } from '@ggui-ai/registry-core';
import { createBearerAuthn } from './authn/bearer.js';
import { createFilesystemBundleStorage } from './filesystem-bundle-storage.js';
import { createFilesystemRegistryStorage } from './filesystem-registry-storage.js';
import { createRegistryServer } from './index.js';

const USAGE = `\
Usage: registry-server [options]

  Self-hostable HTTP server for the ggui marketplace registry. Pairs with
  the \`ggui gadget\` and \`ggui blueprint\` CLIs over a bearer token.

Options:
  --port=<n>                  Listening port (default: 9001; 0 for OS-assigned)
  --host=<h>                  Listening host (default: 0.0.0.0)
  --storage=fs:<path>         Filesystem state root (persistent)
  --storage=memory            In-memory state (wiped on restart)
  --token=<t>                 Bearer token. Or set GGUI_REGISTRY_TOKEN
  --subject=<s>               Verified-caller subject (default: token-hash prefix)
  --bundle-host=<url>         Public URL prefix served bundles fetch from
                              (e.g. http://localhost:9001). Required.
  --registry-hostname=<h>     Hostname embedded in publish installCommand
                              (e.g. localhost:9001). Required.
  --help, -h                  Show this help

Examples:
  # Local dev with in-memory state + a test token
  GGUI_REGISTRY_TOKEN=test-token registry-server \\
    --storage=memory --bundle-host=http://localhost:9001 \\
    --registry-hostname=localhost:9001

  # Self-hosted with filesystem persistence on port 8080
  registry-server --storage=fs:./registry-data --port=8080 \\
    --token=$(openssl rand -hex 32) \\
    --bundle-host=https://registry.example.com \\
    --registry-hostname=registry.example.com
`;

interface ParsedFlags {
  readonly port: number;
  readonly host: string;
  readonly storage: { kind: 'fs'; path: string } | { kind: 'memory' };
  readonly token: string;
  readonly subject?: string;
  readonly bundleHost: string;
  readonly registryHostname: string;
}

function parseFlags(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedFlags {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unknown positional argument: ${arg}`);
    }
    const eqIdx = arg.indexOf('=');
    if (eqIdx < 0) {
      throw new Error(`flag ${arg} requires a value (use --${arg.slice(2)}=<value>)`);
    }
    const key = arg.slice(2, eqIdx);
    const value = arg.slice(eqIdx + 1);
    flags.set(key, value);
  }

  // ── port ────────────────────────────────────────────────────────────
  let port = 9001;
  const rawPort = flags.get('port');
  if (rawPort !== undefined) {
    const n = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`--port must be an integer in [0, 65535] (got ${rawPort})`);
    }
    port = n;
  }

  // ── host ────────────────────────────────────────────────────────────
  const host = flags.get('host') ?? '0.0.0.0';

  // ── storage ─────────────────────────────────────────────────────────
  const rawStorage = flags.get('storage');
  if (rawStorage === undefined) {
    throw new Error('--storage is required. Use --storage=fs:<path> or --storage=memory');
  }
  let storage: ParsedFlags['storage'];
  if (rawStorage === 'memory') {
    storage = { kind: 'memory' };
  } else if (rawStorage.startsWith('fs:')) {
    const path = rawStorage.slice(3);
    if (path.length === 0) {
      throw new Error('--storage=fs:<path> requires a non-empty path');
    }
    storage = { kind: 'fs', path: resolve(path) };
  } else {
    throw new Error(
      `--storage=${rawStorage} is invalid. Use --storage=fs:<path> or --storage=memory`,
    );
  }

  // ── token ───────────────────────────────────────────────────────────
  const token = flags.get('token') ?? env['GGUI_REGISTRY_TOKEN'];
  if (token === undefined || token.length === 0) {
    throw new Error(
      'bearer auth requires --token=<t> or GGUI_REGISTRY_TOKEN environment variable',
    );
  }

  // ── subject ─────────────────────────────────────────────────────────
  const subject = flags.get('subject');

  // ── bundleHost ──────────────────────────────────────────────────────
  const bundleHost = flags.get('bundle-host');
  if (bundleHost === undefined || bundleHost.length === 0) {
    throw new Error(
      '--bundle-host=<url> is required (the public URL prefix served bundles fetch from)',
    );
  }

  // ── registryHostname ────────────────────────────────────────────────
  const registryHostname = flags.get('registry-hostname');
  if (registryHostname === undefined || registryHostname.length === 0) {
    throw new Error(
      '--registry-hostname=<h> is required (the hostname embedded in publish installCommand)',
    );
  }

  return { port, host, storage, token, subject, bundleHost, registryHostname };
}

async function main(): Promise<void> {
  let flags: ParsedFlags;
  try {
    flags = parseFlags(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(`registry-server: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write('Run with --help for usage.\n');
    process.exit(2);
  }

  const storage =
    flags.storage.kind === 'memory'
      ? inMemoryRegistryStorage()
      : await initFilesystemStorage(flags.storage.path);

  const bundleStorage =
    flags.storage.kind === 'memory'
      ? inMemoryBundleStorage({ bundleHost: flags.bundleHost })
      : createFilesystemBundleStorage({
          root: flags.storage.path,
          bundleHost: flags.bundleHost,
        });

  const authn = createBearerAuthn({
    token: flags.token,
    subject: flags.subject,
  });

  const handle = createRegistryServer({
    storage,
    bundleStorage,
    authn,
    host: flags.host,
    port: flags.port,
    bundleHost: flags.bundleHost,
    registryHostname: flags.registryHostname,
  });

  await handle.start();
  process.stdout.write(
    `registry-server listening on http://${flags.host}:${handle.actualPort}\n`,
  );

  // ── Graceful shutdown ──────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`registry-server: received ${signal}, shutting down\n`);
    handle
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        process.stderr.write(`registry-server: shutdown failed: ${err}\n`);
        process.exit(1);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function initFilesystemStorage(root: string) {
  await mkdir(root, { recursive: true });
  return createFilesystemRegistryStorage({ root });
}

void main();
