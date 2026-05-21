/**
 * Scenario 6 — sample-agent + todo MCP real-data round trip.
 *
 * The flagship integration test. Exercises the full agent loop:
 *   1. User prompts: "add a todo: buy milk"
 *   2. Agent calls `todo_add` on the todo MCP → state mutates
 *   3. Agent calls ggui handshake + push → renders a todo UI
 *
 * Real backing state assertion: read `/admin/state` on the todo MCP
 * AFTER the flow completes and confirm the new todo is present.
 *
 * The sample agent boots ON DEMAND so the suite skips cleanly when
 * `ANTHROPIC_API_KEY` is missing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { callTool } from '../fixtures/mcp-client.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { cleanEnv } from '../fixtures/clean-env.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const TODO_PORT = Number.parseInt(process.env.TODO_PORT ?? '6782', 10);
const SAMPLE_PORT = Number.parseInt(process.env.SAMPLE_PORT ?? '6790', 10);
const TODO_MCP = `http://localhost:${TODO_PORT}/mcp`;
const TODO_ADMIN = `http://localhost:${TODO_PORT}/admin`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

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

describe.skipIf(!HAS_KEY)(
  'Scenario 6 — sample-agent + todo MCP real-data round trip',
  () => {
    let sampleAgent: ChildProcess | undefined;
    let handle: BrowserHandle;

    beforeAll(async () => {
      // Reset todo MCP state — every scenario boots from an empty list.
      const reset = await fetch(`${TODO_ADMIN}/reset`, { method: 'POST' });
      expect(reset.ok).toBe(true);

      sampleAgent = spawn(
        'pnpm',
        ['--filter', '@ggui-samples/agent-claude-sdk', 'start'],
        {
          env: {
            ...cleanEnv(),
            PORT: String(SAMPLE_PORT),
            GGUI_MCP_URL: `http://localhost:${GGUI_PORT}/mcp`,
            GGUI_TODO_MCP_URL: TODO_MCP,
          },
          stdio: 'pipe',
        },
      );
      sampleAgent.stdout?.on('data', () => undefined);
      sampleAgent.stderr?.on('data', () => undefined);

      await waitForUrl(`http://localhost:${SAMPLE_PORT}/`, 30_000);
    }, 60_000);

    afterAll(async () => {
      if (sampleAgent && !sampleAgent.killed) {
        sampleAgent.kill('SIGTERM');
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
        await page.goto(`http://localhost:${SAMPLE_PORT}/`, {
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
