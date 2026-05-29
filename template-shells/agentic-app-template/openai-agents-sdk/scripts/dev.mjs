#!/usr/bin/env node
/**
 * `pnpm dev` — start the whole app with ONE command. The banner lists every
 * server and its port (so you always know what's running in the background),
 * and the app opens automatically. Server logs are HIDDEN by default so that
 * map stays on screen; add `--verbose` (or `-v`) to stream the full labeled
 * output. A crashing service still dumps its recent output even in quiet mode.
 *
 *   ggui   UI-generator MCP server            backend
 *   mcps   every server under servers/mcps/*  backend — your domain tools
 *   agent  the LLM backend                    backend
 *   web    the app you actually open          ← visit this
 *
 * Each group runs in its own process group; Ctrl-C tears down the whole tree
 * (no orphaned servers holding ports). `pnpm dev:stop` is the backstop. Adding
 * an MCP server? Drop it under `servers/mcps/` — `dev:mcps` globs the whole
 * directory, so it starts automatically with no edit here.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const WEB_URL = `http://localhost:${process.env.WEB_PORT ?? 6890}`;
const AGENT_PORT = 6791; // per shell — claude=6790, openai=6791, google=6792
const POSIX = process.platform !== 'win32';
const VERBOSE =
  process.argv.slice(2).some((a) => a === '--verbose' || a === '-v') ||
  process.env.DEV_VERBOSE === '1';

// name → color, the package.json script, where it listens, and a one-liner.
const SERVICES = [
  { name: 'ggui', color: 34, script: 'dev:ggui', where: 'http://localhost:6781/mcp', note: 'UI generator (backend)' },
  { name: 'mcps', color: 35, script: 'dev:mcps', where: 'http://localhost:6782/mcp', note: 'your tools · every servers/mcps/*' },
  { name: 'agent', color: 32, script: 'dev:agent', where: `http://localhost:${AGENT_PORT}`, note: 'LLM backend' },
  { name: 'web', color: 36, script: 'dev:web', where: WEB_URL, note: 'the app you open  ←' },
];
const nameW = Math.max(...SERVICES.map((s) => s.name.length));
const whereW = Math.max(...SERVICES.map((s) => s.where.length));
const tag = (s) => `\x1b[${s.color}m[${s.name.padEnd(nameW)}]\x1b[0m`;
const table = SERVICES.map(
  (s) => `    \x1b[${s.color}m${s.name.padEnd(nameW)}\x1b[0m  ${s.where.padEnd(whereW)}  ${s.note}`,
).join('\n');

const logHint = VERBOSE
  ? `Streaming logs, labeled ${SERVICES.map(tag).join(' ')}.`
  : 'Logs are hidden — run \x1b[1mpnpm dev --verbose\x1b[0m to stream them.';

process.stdout.write(`
  Starting your ggui app — ${SERVICES.length} servers, one command:

${table}

  \x1b[1m👉  Open ${WEB_URL}\x1b[0m  (opens automatically once 'web' is ready).
  The other three are backend servers; all ${SERVICES.length} run in the BACKGROUND until
  you press Ctrl-C, which stops every one of them (or \x1b[1mpnpm dev:stop\x1b[0m if a port sticks).
  ${logHint}

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
