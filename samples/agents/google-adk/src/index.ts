/* eslint-disable no-console */
/**
 * Boot entry point — picks up env, starts the HTTP server.
 *
 *   PORT              (default 6792)
 *   GGUI_MCP_URL      (default http://localhost:6781/mcp)
 *   GGUI_TODO_MCP_URL (optional, second MCP for domain tools)
 *   GEMINI_MODEL      (default gemini-3.5-flash)
 *   SYSTEM_PROMPT     override the default ggui-agent system prompt
 *                     (set SYSTEM_PROMPT=none to disable entirely)
 *   GEMINI_API_KEY    required (the agent fails-fast on first /chat
 *                     if absent — see agent.ts). GOOGLE_API_KEY is
 *                     accepted as a fallback for parity with the ADK's
 *                     own env discovery.
 *
 * Auto-loads `.env.local` walking up from this file, so a workspace-
 * root `.env.local` is picked up without explicit sourcing.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { startServer } from './server.js';

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

const PORT = Number(process.env.PORT ?? 6792);
const MCP_URL = process.env.GGUI_MCP_URL ?? 'http://localhost:6781/mcp';
const TODO_MCP_URL = process.env.GGUI_TODO_MCP_URL;
const MODEL = process.env.GEMINI_MODEL;
const SYSTEM_PROMPT_ENV = process.env.SYSTEM_PROMPT;
const systemPrompt =
  SYSTEM_PROMPT_ENV === 'none'
    ? null
    : SYSTEM_PROMPT_ENV !== undefined
      ? SYSTEM_PROMPT_ENV
      : undefined;

startServer({
  port: PORT,
  mcpUrl: MCP_URL,
  ...(TODO_MCP_URL ? { todoMcpUrl: TODO_MCP_URL } : {}),
  ...(MODEL ? { model: MODEL } : {}),
  ...(systemPrompt !== undefined ? { systemPrompt } : {}),
}).catch((err: unknown) => {
  console.error('[sample-agent] failed to start:', err);
  process.exit(1);
});
