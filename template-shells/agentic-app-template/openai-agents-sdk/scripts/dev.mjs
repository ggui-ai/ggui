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
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const WEB_URL = `http://localhost:${process.env.WEB_PORT ?? 6890}`;
const AGENT_PORT = 6790; // uniform — every SDK shell uses 6790
// Keys this template needs before anything can run. Each requirement is met if
// ANY of its `keys` is set; ALL requirements must be met. Both the agent and
// ggui's UI generation run on OpenAI (servers/ggui/ggui.json), so the single
// OPENAI_API_KEY covers both.
const REQUIRED_ENV = [
  {
    keys: ['OPENAI_API_KEY'],
    role: 'the agent loop AND ggui UI generation',
    url: 'https://platform.openai.com/api-keys',
    sample: 'sk-...',
  },
];
const POSIX = process.platform !== 'win32';
const VERBOSE =
  process.argv.slice(2).some((a) => a === '--verbose' || a === '-v') ||
  process.env.DEV_VERBOSE === '1';

// Walk up from the cwd looking for the nearest .env.local — mirrors the
// agent's own env discovery so the preflight never false-alarms when the
// key lives in a parent dir (e.g. a workspace root).
function findEnvLocalPath() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env.local');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readEnvLocal() {
  const path = findEnvLocalPath();
  if (path === null) return null;
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function keyIsSet(name, fileEnv) {
  if ((process.env[name] ?? '').trim() !== '') return true;
  if (fileEnv && (fileEnv[name] ?? '').trim() !== '') return true;
  return false;
}

// Fail loud + early when a required key is missing. Without them the agent
// loop and/or ggui's UI generation can't run — and the failure otherwise hides
// as a single buried log line, which reads as "it just hung".
function preflightEnv() {
  const fileEnv = readEnvLocal();
  const missing = REQUIRED_ENV.filter(
    (req) => !req.keys.some((k) => keyIsSet(k, fileEnv)),
  );
  if (missing.length === 0) return;

  const noFile = fileEnv === null;
  const rule = '═'.repeat(64);
  const out = ['', `\x1b[1;31m${rule}\x1b[0m`];
  out.push(
    `\x1b[1;31m  ✖  Missing required API key${missing.length > 1 ? 's' : ''}` +
      `${noFile ? ' — no .env.local found' : ''}\x1b[0m`,
  );
  out.push(`\x1b[1;31m${rule}\x1b[0m`);
  for (const req of missing) {
    out.push(`  \x1b[1m${req.keys[0]}\x1b[0m — needed for ${req.role}`);
  }
  out.push('');
  out.push(
    `  ${noFile ? 'cp .env.example .env.local' : 'open .env.local'}, then set:`,
  );
  for (const req of missing) {
    out.push(`      \x1b[36m${req.keys[0]}=${req.sample}\x1b[0m`);
  }
  out.push('  …and re-run \x1b[1mpnpm dev\x1b[0m.');
  out.push('');
  for (const req of missing) {
    out.push(`  ${req.keys[0]} → \x1b[36m${req.url}\x1b[0m`);
  }
  out.push(`\x1b[1;31m${rule}\x1b[0m`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
  process.exit(1);
}

// Before anything spawns — a missing key is the #1 first-run mistake.
preflightEnv();

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
      // A missing/failed opener (e.g. a headless container with no xdg-open)
      // emits an ASYNC 'error' event — without this handler Node treats it as
      // unhandled and crashes the whole dev tree. Opening is best-effort; the
      // URL is printed above, so a no-op is fine.
      const opener = spawn(cmd, args, { stdio: 'ignore', detached: true });
      opener.on('error', () => {});
      opener.unref();
    } catch {
      /* headless — the URL is printed above, which is enough */
    }
    return;
  }
})();
