#!/usr/bin/env node
/**
 * `pnpm dev` — start the whole app with ONE command, a clear banner, labeled
 * logs, and an auto-opened browser, so you never have to wonder "which URL do
 * I open?".
 *
 * It runs four service groups (each is also runnable on its own via the
 * matching `dev:*` script in package.json):
 *
 *   ggui   UI-generator MCP server            backend
 *   mcps   every server under servers/mcps/*  backend — your domain tools
 *   agent  the LLM backend                    backend
 *   web    the app you actually open          ← visit this
 *
 * No third-party process runner: pnpm starts each group, and this script just
 * multiplexes their output under [name] prefixes, then opens the web app once
 * it answers. Adding an MCP server? Drop it under `servers/mcps/` — `dev:mcps`
 * globs the whole directory, so it starts automatically with no edit here.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const WEB_URL = `http://localhost:${process.env.WEB_PORT ?? 6890}`;

// name → ANSI color + the package.json script that starts it.
const SERVICES = [
  { name: 'ggui', color: 34, script: 'dev:ggui' }, // blue
  { name: 'mcps', color: 35, script: 'dev:mcps' }, // magenta
  { name: 'agent', color: 32, script: 'dev:agent' }, // green
  { name: 'web', color: 36, script: 'dev:web' }, // cyan
];
const width = Math.max(...SERVICES.map((s) => s.name.length));
const tag = (s) => `\x1b[${s.color}m[${s.name.padEnd(width)}]\x1b[0m`;

process.stdout.write(`
  Starting your ggui app — ${SERVICES.length} services, one command.

    ggui    UI-generator MCP     backend · nothing to open here
    mcps    your domain tools    backend · every servers/mcps/* starts here
    agent   LLM backend          backend · nothing to open here
    web     the app you open  →  ${WEB_URL}

  \x1b[1m👉  Open ${WEB_URL}\x1b[0m  (opens for you once 'web' is ready)

  Logs below are labeled ${SERVICES.map(tag).join(' ')}.

`);

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGINT');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

for (const s of SERVICES) {
  const child = spawn('pnpm', [s.script], { env: process.env });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) =>
      process.stdout.write(`${tag(s)} ${line}\n`),
    );
  }
  child.on('exit', (code) => {
    if (!shuttingDown && code) {
      process.stdout.write(`${tag(s)} exited (code ${code}) — stopping the others.\n`);
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
