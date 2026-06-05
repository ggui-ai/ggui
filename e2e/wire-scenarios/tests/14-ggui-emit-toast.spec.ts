/**
 * Scenario 14 — `ggui_emit` toast notification driven by the agent.
 *
 * Companion to scenarios 7 (ggui_update for re-render) and 12
 * (server-driven ggui_update propagation). Where ggui_update refreshes
 * PROPS in place, ggui_emit pushes a STREAM frame on a declared
 * `streamSpec.<channel>`. The iframe's generated component subscribes
 * to the channel and renders frames as they land.
 *
 * Test choreography:
 *   1. Pre-seed two todos.
 *   2. Prompt the agent to render todos with checkboxes AND a toast
 *      banner. Contract has `streamSpec.toast` with a `text` payload.
 *      Prompt explicitly tells the agent: after `todo_toggle`, call
 *      `ggui_emit` on the `toast` channel with the confirmation text.
 *   3. Wait for the iframe to mount.
 *   4. Click "buy milk".
 *   5. Agent toggles + emits toast.
 *   6. Assert: toast text appears in the iframe AND ggui_emit was in
 *      the tool tape with the right channel.
 *
 * `ggui_emit` was previously NOT in the sample-agent's allowedTools
 * (Phase 1 of this scenario added it). If the agent doesn't reach for
 * it on its own when the contract declares a streamSpec, the bug is
 * in the protocol's self-teaching surface (tool description + server
 * instructions), NOT here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { callTool } from '../fixtures/mcp-client.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { cleanEnv } from '../fixtures/clean-env.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const TODO_PORT = Number.parseInt(process.env.TODO_PORT ?? '6782', 10);
const SAMPLE_PORT = Number.parseInt(process.env.SAMPLE_PORT_14 ?? '6793', 10);
const TODO_MCP = `http://localhost:${TODO_PORT}/mcp`;
const TODO_ADMIN = `http://localhost:${TODO_PORT}/admin`;

interface Todo {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: string;
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function seedTodos(texts: ReadonlyArray<string>): Promise<ReadonlyArray<Todo>> {
  const created: Todo[] = [];
  for (const text of texts) {
    const resp = await callTool(TODO_MCP, 'todo_add', { text });
    const todo = (resp.result?.structuredContent as { todo: Todo } | undefined)?.todo;
    if (!todo) throw new Error(`todo_add failed for "${text}"`);
    created.push(todo);
  }
  return created;
}

// SKIPPED 2026-05-14: this scenario asks the LLM to author a
// streamSpec.toast channel AND emit on it from the agent side AFTER a
// domain-tool toggle. Three load-bearing prerequisites that are NOT
// yet pinned:
//   - haiku reliably extends the contract with streamSpec when prompted
//     (currently nondeterministic);
//   - the LLM-generated component subscribes to the streamSpec channel
//     correctly (the ui-gen triad's streamSpec authoring guidance is
//     thin — see triad audit follow-up);
//   - haiku calls ggui_emit after a domain-tool mutation (same model
//     ceiling as scenario 07's missing ggui_update).
// Re-enable after the planned ggui_update kind:'merge'|'replace'
// redesign + streamSpec triad reinforcement.
describe.skip(
  'Scenario 14 — agent-driven ggui_emit toast on toggle',
  () => {
    let sampleAgent: ChildProcess | undefined;
    let handle: BrowserHandle;

    beforeAll(async () => {
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
      await fetch(`${TODO_ADMIN}/reset`, { method: 'POST' });
      await seedTodos(['buy milk', 'walk the dog']);
      handle = await openBrowser({ relayToolCallsToMcp: false });
    });

    afterEach(async () => {
      await handle.close();
    });

    test(
      'click → todo_toggle → agent emits toast on declared channel → iframe renders text',
      async () => {
        const { page } = handle;

        // SDK tape capture — same shape as scenarios 7/13.
        await page.addInitScript(() => {
          interface ChatHook { __chatSdkMessages?: unknown[] }
          (window as unknown as ChatHook).__chatSdkMessages = [];
          const origFetch = window.fetch;
          window.fetch = async function instrumentedFetch(input, init) {
            const resp = await origFetch(input, init);
            const url =
              typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.href
                  : (input as Request).url;
            if (url.endsWith('/chat')) {
              const cloned = resp.clone();
              void (async () => {
                const reader = cloned.body?.getReader();
                if (!reader) return;
                const decoder = new TextDecoder();
                let buffer = '';
                for (;;) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });
                  let split = buffer.indexOf('\n\n');
                  while (split >= 0) {
                    const frame = buffer.slice(0, split);
                    buffer = buffer.slice(split + 2);
                    const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
                    if (dataLine) {
                      try {
                        const parsed = JSON.parse(dataLine.slice('data:'.length).trim());
                        (window as unknown as ChatHook).__chatSdkMessages!.push(parsed);
                      } catch { /* skip malformed */ }
                    }
                    split = buffer.indexOf('\n\n');
                  }
                }
              })();
            }
            return resp;
          };
        });

        await page.goto(`http://localhost:${SAMPLE_PORT}/`, {
          waitUntil: 'networkidle',
        });

        // Prompt steers the agent toward a contract with streamSpec.toast
        // AND nudges it to call ggui_emit after the toggle. Explicit
        // about both halves — the agent must declare the channel in the
        // contract AND emit on it for the test to pass.
        const prompt = [
          'Show me my todo list. GguiSession each todo as a row with a checkbox',
          "in front of the todo's text. ALSO render a toast banner area at",
          'the top of the UI that subscribes to a streamSpec channel named',
          '"toast" — when a frame arrives on that channel, display the',
          "frame's `text` field as a visible banner for a few seconds.",
          'When I click a checkbox, call the todo_toggle tool with that',
          'todo\'s id, then call ggui_emit on the "toast" channel with',
          '`{text: "Marked <todo text> done"}` (or "un-done") so I see a',
          'confirmation banner. Use ggui_update or ggui_render to refresh',
          'the list visually too.',
        ].join(' ');
        const promptBox = page.getByRole('textbox').first();
        await promptBox.fill(prompt);
        await page.getByRole('button', { name: /^send$/i }).click();

        // Wait for the iframe to mount with buy-milk visible.
        const iframeLocator = page.locator('iframe[data-ggui-mcp-app-iframe]');
        await iframeLocator.first().waitFor({ state: 'attached', timeout: 120_000 });
        const iframeFrame = iframeLocator.first().contentFrame();
        if (!iframeFrame) throw new Error('iframe contentFrame() returned null');
        await iframeFrame
          .getByText(/buy milk/i)
          .first()
          .waitFor({ state: 'visible', timeout: 120_000 });

        // Click "buy milk".
        const clickTargets = [
          iframeFrame.getByRole('checkbox', { name: /buy milk/i }).first(),
          iframeFrame.locator('label').filter({ hasText: /buy milk/i }).first(),
          iframeFrame.getByRole('listitem').filter({ hasText: /buy milk/i }).first(),
          iframeFrame.getByText(/buy milk/i).first(),
        ];
        let clicked = false;
        for (const target of clickTargets) {
          try {
            if (!(await target.isVisible({ timeout: 1000 }))) continue;
            await target.click({ timeout: 5000 });
            clicked = true;
            break;
          } catch { /* try next */ }
        }
        expect(clicked, 'no clickable "buy milk" element found in iframe').toBe(true);

        // Poll the iframe DOM for the toast text. The agent should
        // emit `text: "Marked buy milk done"` (or close variant) on
        // the toast channel; the generated component renders it as a
        // banner. Tolerate the LLM's phrasing variance.
        const toastDeadline = Date.now() + 90_000;
        let toastSeen = false;
        let lastIframeText = '';
        while (Date.now() < toastDeadline) {
          const frames = await page.locator('iframe[data-ggui-mcp-app-iframe]').all();
          const topFrame = frames[frames.length - 1]?.contentFrame();
          if (!topFrame) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          try {
            const text = await topFrame.locator('body').innerText({ timeout: 500 }).catch(() => '');
            lastIframeText = text;
            // The emitted toast text references buy-milk + a done-state
            // word. Accept "Marked buy milk done" / "buy milk done" /
            // "buy milk completed" / similar.
            if (/buy milk/i.test(text) && /(done|completed|marked|✓|checked)/i.test(text)) {
              toastSeen = true;
              break;
            }
          } catch { /* iframe transitioning */ }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!toastSeen) {
          // eslint-disable-next-line no-console
          console.error(
            '[scenario-14] toast text never rendered in iframe; last snapshot:',
            lastIframeText.slice(0, 600),
          );
        }
        expect(toastSeen).toBe(true);

        // Wire-level evidence — ggui_emit was called on the toast channel.
        interface AnthropicContent {
          readonly type?: string;
          readonly name?: string;
          readonly input?: Record<string, unknown>;
        }
        interface SdkMessage {
          readonly message?: { readonly content?: ReadonlyArray<AnthropicContent> };
        }
        const sdkMessages = (await page.evaluate(() => {
          interface ChatHook { __chatSdkMessages?: unknown[] }
          return (window as unknown as ChatHook).__chatSdkMessages ?? [];
        })) as ReadonlyArray<SdkMessage>;

        const toolUses: AnthropicContent[] = [];
        for (const m of sdkMessages) {
          for (const c of m.message?.content ?? []) {
            if (c.type === 'tool_use') toolUses.push(c);
          }
        }
        const emitCalls = toolUses.filter((u) => u.name === 'mcp__ggui__ggui_emit');
        expect(
          emitCalls.length,
          `expected at least one ggui_emit call; saw [${toolUses.map((u) => u.name).join(', ')}]`,
        ).toBeGreaterThan(0);
        const toastEmits = emitCalls.filter(
          (u) => (u.input as { channel?: string } | undefined)?.channel === 'toast',
        );
        expect(
          toastEmits.length,
          `expected ggui_emit on "toast" channel; channels seen: [${emitCalls.map((u) => (u.input as { channel?: string } | undefined)?.channel).join(', ')}]`,
        ).toBeGreaterThan(0);
      },
      300_000,
    );
  },
);
