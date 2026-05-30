/* eslint-disable no-console */
/**
 * Boot entry point — wires environment variables to the HTTP server.
 *
 * Env vars consumed here:
 *
 *   PORT                Chat backend HTTP port (default 6790)
 *   SANDBOX_PROXY_PORT  Spec-mandated second-origin sandbox port (default 7790)
 *   GGUI_MCP_URL        Primary ggui MCP endpoint
 *                       (default http://localhost:6781/mcp)
 *   GGUI_TODO_MCP_URL   Optional second MCP for domain tools (todo demo).
 *                       Omitted by default — the agent runs ggui-only.
 *   MODEL               Override the default Claude model (default
 *                       `claude-sonnet-4-6` — see agent.ts)
 *   SYSTEM_PROMPT       Override the default ggui-agent system prompt.
 *                       Set to `none` to disable entirely (use the SDK's
 *                       built-in default).
 *   ANTHROPIC_API_KEY   Required. The agent fails-fast AT BOOT if absent
 *                       (checked below + in agent.ts).
 *
 * Adding another MCP server: one entry below + one env var. The agent
 * also needs an `ALLOWED_TOOLS_BY_SERVER` entry in `agent.ts` for its
 * tool prefix.
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
import type { McpServerConfig } from '@ggui-ai/agent-server';
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

// Fail loud + early when the provider key is missing. The agent loop AND
// ggui's UI generation both need it; without it the agent would otherwise
// crash mid-request with a buried error. (The `pnpm dev` orchestrator runs
// the same check before booting — this also covers running the agent
// standalone or in a deploy.)
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error(
    '\n[sample-agent] ANTHROPIC_API_KEY is not set — the agent loop and ' +
      "ggui's UI generation both require it.\n" +
      '  Add it to .env.local (copy .env.example), then restart.\n',
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 6790);
const SANDBOX_PROXY_PORT = process.env.SANDBOX_PROXY_PORT
  ? Number(process.env.SANDBOX_PROXY_PORT)
  : 7790;
const MODEL = process.env.MODEL;
const SYSTEM_PROMPT_ENV = process.env.SYSTEM_PROMPT;
const systemPrompt =
  SYSTEM_PROMPT_ENV === 'none'
    ? null
    : SYSTEM_PROMPT_ENV !== undefined
      ? SYSTEM_PROMPT_ENV
      : undefined; // undefined → agent.ts uses DEFAULT_SYSTEM_PROMPT

// MCP servers the agent can call into. `ggui` is the one fixed render endpoint
// (the relay handlers in server.ts forward to it). Every *other* MCP is a
// domain server discovered from the env: any `GGUI_<NAME>_MCP_URL` registers as
// `<name>`, so adding an MCP server needs no change here — just the env var
// (e.g. `GGUI_TODO_MCP_URL` → `todo`, `GGUI_ORDERS_MCP_URL` → `orders`).
const mcpServers: Record<string, McpServerConfig> = {
  ggui: { url: process.env.GGUI_MCP_URL ?? 'http://localhost:6781/mcp' },
};
for (const [key, url] of Object.entries(process.env)) {
  const match = /^GGUI_(.+)_MCP_URL$/.exec(key);
  if (match && url) mcpServers[match[1].toLowerCase()] = { url };
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
