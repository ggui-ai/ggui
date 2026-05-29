#!/usr/bin/env node
/**
 * `pnpm dev:stop` — free the dev ports if a previous `pnpm dev` left a
 * straggler (e.g. after a hard `kill -9`). `pnpm dev` already tears down its
 * own process tree on Ctrl-C, so this is just a backstop.
 */
import { execFileSync } from 'node:child_process';

// ggui (6781), the MCP servers (6782+), the agent (6790/6791/6792 by SDK), web (6890).
const PORTS = [6781, 6782, 6790, 6791, 6792, 6890];
let freed = 0;

for (const port of PORTS) {
  let listed;
  try {
    listed = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error('lsof not found — stop the servers manually, e.g. `pkill -f tsx && pkill -f vite`.');
      process.exit(1);
    }
    continue; // lsof exits non-zero when nothing is listening on this port
  }
  for (const pid of listed.split('\n').map((s) => s.trim()).filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGKILL');
      console.log(`  freed :${port} (pid ${pid})`);
      freed++;
    } catch {
      /* already gone */
    }
  }
}

console.log(freed ? `\n✓ freed ${freed} stale process(es).` : '✓ no stale dev processes found.');
