/* eslint-disable no-console */
/**
 * Boot entry point — picks up env, starts the HTTP server.
 *
 *   PORT            (default 6790)
 *   GGUI_MCP_URL    (default http://localhost:6781/mcp)
 *   SYSTEM_PROMPT   override the default ggui-agent system prompt
 *                   (set SYSTEM_PROMPT=none to disable entirely)
 *   ANTHROPIC_API_KEY  required (the agent fails-fast on first /chat
 *                       if absent — see agent.ts)
 *
 * Auto-loads `.env.local` walking up from this file, so a workspace-
 * root `.env.local` is picked up without explicit sourcing. External
 * devs cloning the sample drop their `.env.local` next to package.json
 * and it's found the same way.
 *
 * For Playwright e2e: spawn `pnpm --filter @ggui-samples/agent-claude-sdk start`
 * with a fixed PORT + GGUI_MCP_URL, wait for the "chat UI ready" beacon
 * on stdout, then drive the browser.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { startServer } from './server.js';

// Walk up looking for the nearest `.env.local`. Picks up the
// workspace-root one when run via pnpm from this package, and the
// project-root one when a dev copies the sample into their own
// project.
function findEnvLocal(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, '.env.local');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const here = dirname(fileURLToPath(import.meta.url));
const envPath = findEnvLocal(here);
if (envPath) {
  loadDotenv({ path: envPath });
  console.log(`[sample-agent] loaded ${envPath}`);
}

const PORT = Number(process.env.PORT ?? 6790);
const SANDBOX_PROXY_PORT = process.env.SANDBOX_PROXY_PORT
  ? Number(process.env.SANDBOX_PROXY_PORT)
  : 7790;
const MCP_URL = process.env.GGUI_MCP_URL ?? 'http://localhost:6781/mcp';
const TODO_MCP_URL = process.env.GGUI_TODO_MCP_URL;
const MODEL = process.env.MODEL;
const SYSTEM_PROMPT_ENV = process.env.SYSTEM_PROMPT;
const systemPrompt =
  SYSTEM_PROMPT_ENV === 'none'
    ? null
    : SYSTEM_PROMPT_ENV !== undefined
      ? SYSTEM_PROMPT_ENV
      : undefined; // undefined → agent.ts uses DEFAULT_SYSTEM_PROMPT

startServer({
  port: PORT,
  sandboxProxyPort: SANDBOX_PROXY_PORT,
  mcpUrl: MCP_URL,
  ...(TODO_MCP_URL ? { todoMcpUrl: TODO_MCP_URL } : {}),
  ...(MODEL ? { model: MODEL } : {}),
  ...(systemPrompt !== undefined ? { systemPrompt } : {}),
}).catch((err: unknown) => {
  console.error('[sample-agent] failed to start:', err);
  process.exit(1);
});
