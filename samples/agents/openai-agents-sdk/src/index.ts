/* eslint-disable no-console */
/**
 * Boot entry point — wires environment variables to the HTTP server.
 *
 * Env vars consumed here:
 *
 *   PORT                Chat backend HTTP port (default 6791)
 *   SANDBOX_PROXY_PORT  Spec-mandated second-origin sandbox port (default 7791)
 *   GGUI_MCP_URL        Primary ggui MCP endpoint
 *                       (default http://localhost:6781/mcp)
 *   GGUI_TODO_MCP_URL   Optional second MCP for domain tools (todo demo).
 *                       Omitted by default — the agent runs ggui-only.
 *   OPENAI_MODEL        Override the default OpenAI model
 *                       (default `gpt-5.5-2026-04-23` — see agent.ts)
 *   SYSTEM_PROMPT       Override the default ggui-agent system prompt.
 *                       Set to `none` to disable entirely.
 *   OPENAI_API_KEY      Required. The agent fails-fast on first `/chat`
 *                       if absent (see agent.ts).
 *
 * Adding another MCP server: one entry below + one env var.
 *
 * Auto-loads `.env.local` walking up from this file, so a workspace-
 * root `.env.local` is picked up without explicit sourcing. External
 * devs cloning the sample drop their `.env.local` next to package.json
 * and it's found the same way.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { McpServerConfig } from '@ggui-ai/agent-server';
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

const PORT = Number(process.env.PORT ?? 6791);
const SANDBOX_PROXY_PORT = process.env.SANDBOX_PROXY_PORT
  ? Number(process.env.SANDBOX_PROXY_PORT)
  : 7791;
const MODEL = process.env.OPENAI_MODEL;
const SYSTEM_PROMPT_ENV = process.env.SYSTEM_PROMPT;
const systemPrompt =
  SYSTEM_PROMPT_ENV === 'none'
    ? null
    : SYSTEM_PROMPT_ENV !== undefined
      ? SYSTEM_PROMPT_ENV
      : undefined;

// MCP servers the agent can call into. `ggui` is required (the relay
// handlers in server.ts forward to this URL); add additional keys to
// expose more MCPs to the LLM.
const mcpServers: Record<string, McpServerConfig> = {
  ggui: { url: process.env.GGUI_MCP_URL ?? 'http://localhost:6781/mcp' },
};
if (process.env.GGUI_TODO_MCP_URL) {
  mcpServers.todo = { url: process.env.GGUI_TODO_MCP_URL };
}

startServer({
  port: PORT,
  sandboxProxyPort: SANDBOX_PROXY_PORT,
  mcpServers,
  ...(MODEL ? { model: MODEL } : {}),
  ...(systemPrompt !== undefined ? { systemPrompt } : {}),
}).catch((err: unknown) => {
  console.error('[sample-agent] failed to start:', err);
  process.exit(1);
});
