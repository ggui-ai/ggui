/**
 * Scenario 6 — sample-agent + todo MCP real-data round trip.
 *
 * The flagship integration test. Exercises the full agent loop:
 *   1. User prompts: "add a todo: buy milk"
 *   2. Agent calls `todo_add` on the todo MCP → state mutates
 *   3. Agent calls ggui handshake + render → a todo UI mounts
 *
 * Real backing state assertion: read `/admin/state` on the todo MCP
 * AFTER the flow completes and confirm the new todo is present.
 *
 * Parametric over the three reference agent SDKs — this is the
 * agent-framework axis of the e2e matrix. Each row spawns its own
 * sample agent against the matching ggui-default-<provider> instance
 * (booted by global-setup.ts), so a regression in any one SDK fails
 * exactly its row. Rows skip cleanly when their API key is missing;
 * set `GGUI_E2E_REQUIRE_ALL_PROVIDERS=1` to hard-fail instead (the
 * label-gated CI path).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { callTool } from '../fixtures/mcp-client.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { cleanEnv } from '../fixtures/clean-env.js';
import { OUTERMOST_WORKSPACE_ROOT } from '../fixtures/workspace-root.js';

const TODO_PORT = Number.parseInt(process.env.TODO_PORT ?? '6782', 10);
const TODO_MCP = `http://localhost:${TODO_PORT}/mcp`;
const TODO_ADMIN = `http://localhost:${TODO_PORT}/admin`;
const REQUIRE_ALL = process.env.GGUI_E2E_REQUIRE_ALL_PROVIDERS === '1';

interface AgentRow {
  /** Display label for the describe block. */
  readonly sdk: string;
  /** Workspace package name spawned via `pnpm --filter`. */
  readonly pkg: string;
  /** Default port the agent's chat UI listens on. */
  readonly samplePort: number;
  /** API key env var the agent's LLM driver requires. */
  readonly apiKey: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY';
  /** Port of the matching ggui-default-<provider> instance (see global-setup.ts). */
  readonly gguiPort: number;
}

const AGENTS: readonly AgentRow[] = [
  {
    sdk: 'claude-agent-sdk',
    pkg: '@ggui-samples/agent-claude-sdk',
    samplePort: Number.parseInt(
      process.env.SAMPLE_PORT_CLAUDE ?? process.env.SAMPLE_PORT ?? '6790',
      10,
    ),
    apiKey: 'ANTHROPIC_API_KEY',
    gguiPort: Number.parseInt(process.env.GGUI_PORT ?? '6781', 10),
  },
  {
    sdk: 'openai-agents-sdk',
    pkg: '@ggui-samples/agent-openai-sdk',
    samplePort: Number.parseInt(process.env.SAMPLE_PORT_OPENAI ?? '6791', 10),
    apiKey: 'OPENAI_API_KEY',
    gguiPort: Number.parseInt(process.env.GGUI_OPENAI_PORT ?? '6787', 10),
  },
  {
    sdk: 'google-adk',
    pkg: '@ggui-samples/agent-google-adk',
    samplePort: Number.parseInt(process.env.SAMPLE_PORT_GOOGLE ?? '6792', 10),
    apiKey: 'GEMINI_API_KEY',
    gguiPort: Number.parseInt(process.env.GGUI_GOOGLE_PORT ?? '6788', 10),
  },
];

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

for (const agent of AGENTS) {
  const hasKey = !!process.env[agent.apiKey];
  // REQUIRE_ALL flips the missing-key behavior from skip → hard-fail
  // (one synthetic test that always throws). Used by label-gated CI to
  // ensure all three providers run when the `run-all-providers` label
  // is on a PR.
  const shouldSkip = !hasKey && !REQUIRE_ALL;

  describe.skipIf(shouldSkip)(
    `Scenario 6 [${agent.sdk}] — sample-agent + todo MCP real-data round trip`,
    () => {
      // REQUIRE_ALL + key missing → emit a single failing test that
      // names the missing env var. Surfaces in CI as the matrix cell
      // that didn't get its credentials wired.
      if (!hasKey) {
        test(`${agent.apiKey} missing (REQUIRE_ALL_PROVIDERS=1)`, () => {
          throw new Error(
            `GGUI_E2E_REQUIRE_ALL_PROVIDERS=1 but ${agent.apiKey} is not set — ` +
              `the ${agent.sdk} row cannot run.`,
          );
        });
        return;
      }

      let sampleAgent: ChildProcess | undefined;
      let handle: BrowserHandle;

      beforeAll(async () => {
        // Reset todo MCP state — every scenario row boots from an empty list.
        const reset = await fetch(`${TODO_ADMIN}/reset`, { method: 'POST' });
        expect(reset.ok).toBe(true);

        sampleAgent = spawn('pnpm', ['--filter', agent.pkg, 'start'], {
          // Spawn from the outermost workspace root: `oss/` carries a
          // nested `pnpm-workspace.yaml`, so a `pnpm` run with CWD
          // inside `oss/` resolves the empty `oss/node_modules` and
          // can't find the hoisted `vite` bin. See
          // fixtures/workspace-root.ts.
          cwd: OUTERMOST_WORKSPACE_ROOT,
          env: {
            ...cleanEnv(),
            PORT: String(agent.samplePort),
            // Each row points at the matching ggui-default-<provider>
            // instance so the full provider stack is exercised end-to-end
            // (agent SDK ↔ ggui server's cold-gen LLM both share the
            // same upstream LLM family per row).
            GGUI_MCP_URL: `http://localhost:${agent.gguiPort}/mcp`,
            GGUI_TODO_MCP_URL: TODO_MCP,
          },
          stdio: 'pipe',
          // Own process group so afterAll can SIGTERM the whole tree
          // (the `pnpm` wrapper + its `tsx`/node child). A bare kill on
          // the wrapper leaves the server child orphaned on its port,
          // which EADDRINUSE-crashes the next run.
          detached: true,
        });
        sampleAgent.stdout?.on('data', (chunk: Buffer) => {
          process.stdout.write(`[${agent.sdk}] ${chunk.toString()}`);
        });
        sampleAgent.stderr?.on('data', (chunk: Buffer) => {
          process.stderr.write(`[${agent.sdk}] ${chunk.toString()}`);
        });

        await waitForUrl(`http://localhost:${agent.samplePort}/`, 30_000);
      }, 60_000);

      afterAll(async () => {
        if (sampleAgent?.pid !== undefined && !sampleAgent.killed) {
          try {
            process.kill(-sampleAgent.pid, 'SIGTERM');
          } catch {
            sampleAgent.kill('SIGTERM');
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      });

      beforeEach(async () => {
        handle = await openBrowser();
      });

      test(
        '"add a todo: buy milk" → agent calls todo_add → state mutates',
        async () => {
          const { page } = handle;
          await page.goto(`http://localhost:${agent.samplePort}/`, {
            waitUntil: 'networkidle',
          });

          const prompt = page.getByRole('textbox').first();
          await prompt.fill('add a todo with the text "buy milk"');
          await page.getByRole('button', { name: /send/i }).click();

          // Poll todo MCP admin state until the new todo appears.
          const deadline = Date.now() + 90_000;
          let found = false;
          while (Date.now() < deadline) {
            const state = (await (
              await fetch(`${TODO_ADMIN}/state`)
            ).json()) as { todos: Array<{ text: string }> };
            if (
              state.todos.some((t) => t.text.toLowerCase().includes('buy milk'))
            ) {
              found = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
          expect(found).toBe(true);

          // Cross-check via the todo MCP's tools/call surface.
          const list = await callTool(TODO_MCP, 'todo_list', {});
          const todos = (
            list.result?.structuredContent as { todos: Array<{ text: string }> }
          ).todos;
          expect(
            todos.some((t) => t.text.toLowerCase().includes('buy milk')),
          ).toBe(true);

          await handle.close();
        },
        180_000,
      );
    },
  );
}
