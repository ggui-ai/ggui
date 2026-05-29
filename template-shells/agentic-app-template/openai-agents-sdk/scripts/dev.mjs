#!/usr/bin/env node
/**
 * `pnpm dev` — start the whole app with ONE command, a clear banner, and an
 * auto-opened browser. By default the servers' logs are HIDDEN so the
 * "open this URL" guidance stays on screen; add `--verbose` (or `-v`) to stream
 * the full labeled output. (A crashing service still dumps its recent output,
 * even in quiet mode, so failures are never silent.)
 *
 *   ggui   UI-generator MCP server            backend
 *   mcps   every server under servers/mcps/*  backend — your domain tools
 *   agent  the LLM backend                    backend
 *   web    the app you actually open          ← visit this
 *
 * Each group runs in its own process group; Ctrl-C tears down the whole tree
 * (no orphaned servers holding ports). `pnpm dev:stop` is the backstop.
 * Adding an MCP server? Drop it under `servers/mcps/` — `dev:mcps` globs the
 * whole directory, so it starts automatically with no edit here.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const WEB_URL = `http://localhost:${process.env.WEB_PORT ?? 6890}`;
const POSIX = process.platform !== 'win32';
const VERBOSE =
  process.argv.slice(2).some((a) => a === '--verbose' || a === '-v') ||
  process.env.DEV_VERBOSE === '1';

// name → ANSI color + the package.json script that starts it.
const SERVICES = [
  { name: 'ggui', color: 34, script: 'dev:ggui' }, // blue
  { name: 'mcps', color: 35, script: 'dev:mcps' }, // magenta
  { name: 'agent', color: 32, script: 'dev:agent' }, // green
  { name: 'web', color: 36, script: 'dev:web' }, // cyan
];
const width = Math.max(...SERVICES.map((s) => s.name.length));
const tag = (s) => `\x1b[${s.color}m[${s.name.padEnd(width)}]\x1b[0m`;

const logHint = VERBOSE
  ? `Streaming logs, labeled ${SERVICES.map(tag).join(' ')}.`
  : 'Logs are hidden — run \x1b[1mpnpm dev --verbose\x1b[0m to stream them.';

process.stdout.write(`
  Starting your ggui app — ${SERVICES.length} services, one command.

    ggui    UI-generator MCP     backend · nothing to open here
    mcps    your domain tools    backend · every servers/mcps/* starts here
    agent   LLM backend          backend · nothing to open here
    web     the app you open  →  ${WEB_URL}

  \x1b[1m👉  Open ${WEB_URL}\x1b[0m  (opens automatically once 'web' is ready)

  ${logHint}
  Ctrl-C stops everything; if a port stays stuck, run \x1b[1mpnpm dev:stop\x1b[0m.

`);

const children = [];
const tails = new Map(); // name → recent output lines (for crash diagnostics in quiet mode)
const TAIL_MAX = 40;
let shuttingDown = false;

// Signal a child's WHOLE process group (pnpm → tsx/vite → the dev servers) so
// nothing orphans and holds a port. On Windows, `taskkill /T` walks the tree.
function killTree(child, signal) {
  if (!child.pid) return;
  try {
    if (POSIX) process.kill(-child.pid, signal);
    else spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child, 'SIGTERM');
  // Anything still alive after a grace period gets force-killed so ports free.
  setTimeout(() => {
    for (const child of children) killTree(child, 'SIGKILL');
    process.exit(code);
  }, 800).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

for (const s of SERVICES) {
  // `detached` puts each group in its own process group so killTree can take
  // down the whole subtree (pnpm only unreliably forwards signals to its kids).
  const child = spawn('pnpm', [s.script], { env: process.env, detached: POSIX });
  children.push(child);
  tails.set(s.name, []);
  // Always consume the pipes (so a full pipe buffer never blocks the child):
  // verbose → print prefixed; quiet → keep only a recent-output ring buffer.
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      if (VERBOSE) {
        process.stdout.write(`${tag(s)} ${line}\n`);
      } else {
        const buf = tails.get(s.name);
        buf.push(line);
        if (buf.length > TAIL_MAX) buf.shift();
      }
    });
  }
  child.on('exit', (code) => {
    if (!shuttingDown && code) {
      process.stdout.write(`\n${tag(s)} exited (code ${code}) — stopping the others.\n`);
      if (!VERBOSE) {
        const buf = tails.get(s.name) ?? [];
        if (buf.length) {
          process.stdout.write(`${tag(s)} recent output:\n`);
          for (const l of buf) process.stdout.write(`  ${l}\n`);
        }
        process.stdout.write("(run `pnpm dev --verbose` to stream full logs)\n");
      }
      shutdown(code);
    }
  });
}

// Announce + open the web app the moment it answers (best-effort; headless is fine).
const DEADLINE = Date.now() + 90_000;
(async function openWhenReady() {
  while (!shuttingDown && Date.now() < DEADLINE) {
    try {
      const res = await fetch(WEB_URL);
      await res.body?.cancel?.();
    } catch {
      await new Promise((r) => setTimeout(r, 600));
      continue;
    }
    process.stdout.write(`\n  \x1b[1;32m✅  ${WEB_URL} is ready — opening it now.\x1b[0m\n\n`);
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['open', [WEB_URL]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', WEB_URL]]
          : ['xdg-open', [WEB_URL]];
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    } catch {
      /* headless — the URL is printed above, which is enough */
    }
    return;
  }
})();
