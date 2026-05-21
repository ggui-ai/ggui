/**
 * Clean environment for sample-agent child processes.
 *
 * When the e2e suite runs INSIDE a Claude Code session, the spawned
 * sample-agent inherits two distinct contamination paths:
 *
 *   1. **Claude Code host env vars** (`CLAUDE_CODE_SSE_PORT`,
 *      `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`, etc.). The Claude
 *      Agent SDK reads these to figure out "am I a child of a Claude
 *      Code host?" and routes some bootstrap accordingly. Stripped
 *      below.
 *
 *   2. **`~/.claude/` credentials** (`.credentials.json` etc.). The
 *      SDK's `query()` spawns the `claude` CLI as a subprocess; that
 *      CLI reads the user's Claude auth and connects to claude.ai's
 *      remote MCP registry, which auto-injects every MCP the operator
 *      has authorized in claude.ai (Figma, Gmail, the claude.ai-hosted
 *      `ggui_*`, …) into the spawned agent's tool catalog. The result:
 *      `mcp__claude_ai_GGUI__ggui_new_session` shows up alongside our
 *      local `mcp__ggui__ggui_new_session`, polluting tool-tape
 *      assertions AND letting the LLM accidentally call the wrong
 *      version of a ggui tool.
 *
 *      Fix: point `CLAUDE_CONFIG_DIR` at a fresh empty directory so
 *      the spawned CLI boots with no credentials, no settings files,
 *      and no remote-MCP registry. `settingSources: []` only handles
 *      the in-SDK settings discovery; the spawned CLI is a separate
 *      process with its own config-dir resolution.
 *
 * `cleanEnv()` returns a sanitized env for `spawn()` callers.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_CODE_HOST_VARS = [
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDECODE',
  'CLAUDE_EFFORT',
  'CLAUDE_CONFIG_DIR',
];

/**
 * Empty Claude config-dir minted on first call, reused across all
 * subsequent calls in the test process. Created inside the OS tmpdir
 * with mode 0700 by `mkdtempSync`.
 */
let isolatedClaudeConfigDir: string | undefined;

function getIsolatedClaudeConfigDir(): string {
  if (isolatedClaudeConfigDir === undefined) {
    isolatedClaudeConfigDir = mkdtempSync(join(tmpdir(), 'ggui-e2e-claude-'));
  }
  return isolatedClaudeConfigDir;
}

export function cleanEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (CLAUDE_CODE_HOST_VARS.includes(k)) continue;
    if (v !== undefined) out[k] = v;
  }
  // Force the spawned `claude` CLI to read from an empty config dir.
  // Path is non-existent state — no credentials, no settings, no
  // remote-MCP catalog gets injected.
  out.CLAUDE_CONFIG_DIR = getIsolatedClaudeConfigDir();
  return out;
}
