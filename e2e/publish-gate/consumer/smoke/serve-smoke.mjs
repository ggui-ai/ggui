#!/usr/bin/env node
/**
 * Clean-room serve smoke — boots the `ggui` binary as a real server.
 *
 * Runs `ggui serve --mcp-only --dev-allow-all` (the OSS self-host path,
 * mirroring the @ggui-samples/ggui-default sample) against a minimal
 * `ggui.json`. The bin and its ENTIRE runtime tree — @ggui-ai/cli →
 * @ggui-ai/mcp-server and everything under it — came from Verdaccio.
 *
 * Booting the server for real exercises far more of the published
 * surface than any static check: the whole MCP-server composition has
 * to load and bind from registry-installed packages.
 *
 * Assertions:
 *   hard — the process binds the port and logs that it is listening
 *   hard — the bound port accepts a TCP connection
 *   soft — HTTP probes of /health and an MCP `initialize` (informational
 *          — exact routes vary by mode; the hard checks already prove
 *          the server is up)
 *   hard — the process shuts down cleanly on SIGTERM
 *
 * Keyless + deterministic: `--mcp-only` skips agent supervision and
 * `--dev-allow-all` skips auth, so no ANTHROPIC_API_KEY / login needed.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consumerRoot = dirname(here);
const bin = join(consumerRoot, 'node_modules', '.bin', 'ggui');

const PORT = 6781;
const sampleDir = mkdtempSync(join(tmpdir(), 'ggui-serve-sample-'));
const HOME = mkdtempSync(join(tmpdir(), 'ggui-serve-home-'));

// Minimal operator config — the @ggui-samples/ggui-default shape.
// `protocol` is a required field; read the real PROTOCOL_VERSION from
// the registry-installed @ggui-ai/protocol so it always matches the
// packages under test.
const { PROTOCOL_VERSION } = await import('@ggui-ai/protocol');
writeFileSync(
  join(sampleDir, 'ggui.json'),
  JSON.stringify(
    {
      schema: '1',
      protocol: PROTOCOL_VERSION,
      app: { slug: 'publish-gate-serve-smoke', name: 'Publish Gate Serve Smoke' },
    },
    null,
    2,
  ),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve once a TCP connection to the port succeeds, or time out. */
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = connect({ host: '127.0.0.1', port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

let fails = 0;
const fail = (m) => {
  fails++;
  console.error(`  FAIL  ${m}`);
};

const child = spawn(
  bin,
  ['serve', '--mcp-only', '--dev-allow-all', '--port', String(PORT)],
  {
    cwd: sampleDir,
    env: { PATH: process.env.PATH, HOME, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

let exitedEarly = false;
child.on('exit', (code) => {
  if (!shuttingDown) {
    exitedEarly = true;
    fail(`ggui serve exited before the probe (code ${code})`);
  }
});
let shuttingDown = false;

try {
  const listening = await waitForPort(PORT, 45_000);

  if (exitedEarly) {
    console.error('        ' + log.trim().split('\n').slice(-8).join('\n        '));
  } else {
    if (listening) console.log(`  ok    ggui serve — bound port ${PORT}`);
    else fail(`ggui serve — port ${PORT} never accepted a connection`);

    if (/listening|serving|ready|http:\/\//i.test(log)) {
      console.log('  ok    ggui serve — logged a listening banner');
    } else {
      fail('ggui serve — no listening banner in output');
    }

    // Soft HTTP probes — the hard checks above already prove the server
    // is up; routes differ between modes so these are informational.
    if (listening) {
      for (const path of ['/health', '/ggui/health']) {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
          console.log(`  info  GET ${path} → ${r.status}`);
        } catch (err) {
          console.log(`  info  GET ${path} → ${String(err.message)}`);
        }
      }
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'publish-gate', version: '0' },
            },
          }),
        });
        console.log(`  info  POST /mcp initialize → ${r.status}`);
      } catch (err) {
        console.log(`  info  POST /mcp initialize → ${String(err.message)}`);
      }
    }
  }
} finally {
  shuttingDown = true;
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) {
    await sleep(100);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    fail('ggui serve — did not exit on SIGTERM (had to SIGKILL)');
  } else if (!exitedEarly) {
    console.log('  ok    ggui serve — clean shutdown on SIGTERM');
  }
  rmSync(sampleDir, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
}

console.log('');
if (fails > 0) {
  console.error(`  serve smoke FAILED — ${fails} check(s)`);
  process.exit(1);
}
console.log('  serve smoke passed — ggui serve boots from registry-installed packages');
