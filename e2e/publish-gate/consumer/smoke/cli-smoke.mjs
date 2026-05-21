#!/usr/bin/env node
/**
 * Clean-room CLI smoke — comprehensive `ggui` binary coverage.
 *
 * The `ggui` bin and its ENTIRE transitive runtime dependency tree
 * came from Verdaccio — no workspace symlinks. Each subcommand
 * lazy-loads its own module subtree, so running every command
 * exercises that whole code path against registry-installed packages —
 * catching per-command phantom deps / broken imports that `--help`
 * alone never touches.
 *
 * Tiers:
 *   A — must exit 0 (and, where noted, produce the expected artifact)
 *   B — must load without a module-resolution crash; any exit code OK
 *       (used for commands whose success depends on context the gate
 *        deliberately does not set up)
 *
 * The auth group (`login` / `whoami` / `keys`) runs against an
 * in-process mock auth server (see mock-auth-server.mjs) with an
 * isolated HOME, so it is fully hermetic and non-interactive.
 *
 * `ggui serve` is covered by its own stage — see serve-smoke.mjs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consumerRoot = dirname(here);
const bin = join(consumerRoot, 'node_modules', '.bin', 'ggui');

if (!existsSync(bin)) {
  console.error(`  FAIL  ggui bin missing at ${bin}`);
  console.error('        — @ggui-ai/cli published without a working `bin` entry');
  process.exit(1);
}

// The mock auth server runs in its OWN process. The CLI tests below use
// the blocking `spawnSync`, which would freeze the event loop of an
// in-process server — leaving `ggui login`'s HTTP calls unanswered.
const mockProc = spawn(process.execPath, [join(here, 'mock-auth-server.mjs')], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const mockUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(
    () => reject(new Error('mock auth server did not report a URL within 10s')),
    10_000,
  );
  mockProc.stdout.on('data', (d) => {
    buf += d;
    const m = buf.match(/MOCK_AUTH_URL=(\S+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  mockProc.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`mock auth server exited early (code ${code})`));
  });
});

const HOME = mkdtempSync(join(tmpdir(), 'ggui-home-'));
const gadgetDir = mkdtempSync(join(tmpdir(), 'ggui-gadget-'));
const blueprintDir = mkdtempSync(join(tmpdir(), 'ggui-blueprint-'));
const keysDir = mkdtempSync(join(tmpdir(), 'ggui-keys-'));
const keysFile = join(keysDir, 'keys.json');

let fails = 0;

function run(args, { cwd, env } = {}) {
  return spawnSync(bin, args, {
    cwd: cwd ?? consumerRoot,
    env: { PATH: process.env.PATH, HOME, CI: '1', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

/** Tier A — must exit 0; `post` is an optional artifact assertion. */
function tierA(label, r, post) {
  if (r.error) {
    fails++;
    console.error(`  FAIL  ${label}  — ${r.error.message}`);
    return;
  }
  if (r.status !== 0) {
    fails++;
    console.error(`  FAIL  ${label}  — exit ${r.status}`);
    const err = (r.stderr || '').trim();
    if (err) console.error('        ' + err.split('\n').slice(0, 4).join('\n        '));
    return;
  }
  if (post && !post()) {
    fails++;
    console.error(`  FAIL  ${label}  — exit 0 but expected artifact missing`);
    return;
  }
  console.log(`  ok    ${label}`);
}

/** Tier B — any exit code OK, but must not crash on module resolution. */
function tierB(label, r) {
  if (r.error) {
    fails++;
    console.error(`  FAIL  ${label}  — ${r.error.message}`);
    return;
  }
  const combined = (r.stdout || '') + (r.stderr || '');
  if (/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/.test(combined)) {
    fails++;
    console.error(`  FAIL  ${label}  — module-resolution crash`);
    console.error('        ' + combined.trim().split('\n').slice(0, 4).join('\n        '));
    return;
  }
  console.log(`  ok    ${label}  (loads cleanly; exit ${r.status})`);
}

const authEnv = { GGUI_API_URL: mockUrl };
const authJson = join(HOME, '.ggui', 'auth.json');

try {
  // ── Tier A — global + author/scaffold commands ──────────────────
  tierA('ggui --version', run(['--version']));
  tierA('ggui --help', run(['--help']));
  tierA(
    'ggui gadget create',
    run(['gadget', 'create', '@smoke/gate-gadget'], { cwd: gadgetDir }),
    () => readdirSync(gadgetDir).length > 0,
  );
  tierA(
    'ggui blueprint create',
    run(['blueprint', 'create', '@smoke/gate-blueprint'], { cwd: blueprintDir }),
    () => readdirSync(blueprintDir).length > 0,
  );

  // ── Tier A — auth group, against the mock auth server ───────────
  tierA('ggui login', run(['login', '--no-open'], { env: authEnv }), () =>
    existsSync(authJson),
  );
  tierA('ggui whoami', run(['whoami'], { env: authEnv }));
  tierA('ggui keys list', run(['keys', 'list'], { env: authEnv }));
  tierA('ggui keys list --keys-file', run(['keys', 'list', '--keys-file', keysFile]));
  tierA('ggui logout', run(['logout']), () => !existsSync(authJson));

  // ── Tier B — context-dependent commands (load-only) ─────────────
  // `dev --no-serve` loads + discovers + exits without binding; its
  // exit code depends on registry/project context the gate doesn't
  // set up, so we only assert its module graph resolves cleanly.
  tierB('ggui dev --no-serve --no-open', run(['dev', '--no-serve', '--no-open']));
} finally {
  mockProc.kill('SIGTERM');
  for (const d of [HOME, gadgetDir, blueprintDir, keysDir]) {
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('');
if (fails > 0) {
  console.error(`  cli smoke FAILED — ${fails} check(s)`);
  process.exit(1);
}
console.log('  cli smoke passed — all subcommands exercised');
