/**
 * Scenario 7 — full LLM-to-LLM round-trip via the wire.
 *
 * Distinct from 1-5 (synthetic agent drives the wire boundary) and 6
 * (real LLM reaches the 2nd MCP, but no UI in the loop). Here BOTH
 * ends are a real LLM and the wire round-trip is exercised:
 *
 *   1. Pre-seed the todo MCP with 3 todos via `tools/call todo_add`.
 *   2. Real user (Playwright) types a prompt in the sample agent's
 *      chat shell asking the agent to render the todos with a toggle.
 *   3. Real LLM agent calls `todo_list` → `ggui_new_session` →
 *      `ggui_handshake` → `ggui_push`, rendering an interactive list.
 *   4. The sample agent's React shell embeds the resulting iframe via
 *      `<McpAppIframe>` (selector: `iframe[data-ggui-mcp-app-iframe]`).
 *   5. Real user clicks the todo labelled "buy milk" inside the iframe.
 *   6. The click → `submit_action` → host relay → pipe-append on the
 *      stackItem-keyed pending-events pipe.
 *   7. The mid-turn LLM agent drains `ggui_consume`, reads the toggle
 *      event, and calls `todo_toggle({id: <the buy-milk id>})` on the
 *      todo MCP.
 *   8. Todo MCP mutates state. Test asserts on `/admin/state`.
 *
 * The actionSpec entry MUST use `dispatch.kind: 'agent'` (event-style)
 * for this flow to work in the current sample setup — the host relay
 * forwards `tools/call` only to the ggui MCP, so `dispatch.kind: 'tool'`
 * with a `todo_*` name has no path to the todo MCP. The prompt nudges
 * the LLM toward the agent-routed pattern.
 *
 * This is the canonical "real production scenario" pin: real user, real
 * LLM, real wire, real domain MCP, real state mutation.
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
// Distinct from scenario 6's 6790 — both spawn the sample agent in
// beforeAll/afterAll, and SIGTERM port-release isn't fast enough to
// reuse the port reliably when the suite runs back-to-back.
const SAMPLE_PORT = Number.parseInt(process.env.SAMPLE_PORT_7 ?? '6791', 10);
const TODO_MCP = `http://localhost:${TODO_PORT}/mcp`;
const TODO_ADMIN = `http://localhost:${TODO_PORT}/admin`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

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
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function seedTodos(
  texts: ReadonlyArray<string>,
): Promise<ReadonlyArray<Todo>> {
  const created: Todo[] = [];
  for (const text of texts) {
    const resp = await callTool(TODO_MCP, 'todo_add', { text });
    const todo = (resp.result?.structuredContent as { todo: Todo } | undefined)
      ?.todo;
    if (!todo) throw new Error(`todo_add failed for "${text}"`);
    created.push(todo);
  }
  return created;
}

async function fetchTodos(): Promise<ReadonlyArray<Todo>> {
  const resp = await fetch(`${TODO_ADMIN}/state`);
  const data = (await resp.json()) as { todos: Todo[] };
  return data.todos;
}

describe.skipIf(!HAS_KEY)(
  'Scenario 7 — full LLM-to-LLM round-trip via the wire',
  () => {
    let sampleAgent: ChildProcess | undefined;
    let handle: BrowserHandle;

    beforeAll(async () => {
      // Start every scenario from a clean slate; we re-seed in beforeEach.
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
      // Empty + re-seed so each test starts identical.
      await fetch(`${TODO_ADMIN}/reset`, { method: 'POST' });
      await seedTodos(['buy milk', 'walk the dog', 'finish report']);
      handle = await openBrowser({ relayToolCallsToMcp: false });
    });

    afterEach(async () => {
      await handle.close();
    });

    test(
      'click "buy milk" in agent-rendered iframe → agent calls todo_toggle → state flips',
      async () => {
        const { page } = handle;

        // Tap the SSE stream from POST /chat so we can later assert on
        // the actual tool calls the LLM made (not just the side-effect
        // state). Wraps fetch BEFORE navigation; each `data:` frame is
        // a Claude Agent SDK message that we accumulate into
        // window.__chatSdkMessages.
        await page.addInitScript(() => {
          interface ChatHook {
            __chatSdkMessages?: unknown[];
          }
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
                    const dataLine = frame
                      .split('\n')
                      .find((l) => l.startsWith('data:'));
                    if (dataLine) {
                      try {
                        const parsed = JSON.parse(
                          dataLine.slice('data:'.length).trim(),
                        );
                        (
                          window as unknown as ChatHook
                        ).__chatSdkMessages!.push(parsed);
                      } catch {
                        /* skip malformed frame */
                      }
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

        // 1. User-style prompt. No wire-mechanics guidance — let the
        //    protocol's self-teaching surfaces (tool descriptions + server
        //    instructions) drive the agent's choices. Explicit about
        //    intent: a checkbox to mark done, not a delete affordance,
        //    so the click maps cleanly to `todo_toggle`.
        const prompt = [
          'Show me my todo list. Render each todo as a row with a checkbox',
          "in front of the todo's text. When I click a checkbox, mark that",
          'todo as done (or un-done) using the todo_toggle tool, then',
          're-render the list so I can see the new state. No delete buttons,',
          'no other controls — just the checkbox per row. Keep listening',
          'for my clicks until I close the UI.',
        ].join(' ');
        const promptBox = page.getByRole('textbox').first();
        await promptBox.fill(prompt);
        await page.getByRole('button', { name: /^send$/i }).click();

        // 2. Wait for the iframe to appear. `<McpAppIframe>` sets
        //    data-ggui-mcp-app-iframe on its <iframe>. This scenario
        //    chains TWO real LLM calls in series:
        //      (a) the sample-agent's LLM picks `ggui_push` (5–30s),
        //      (b) ggui-default's cold-gen produces the component
        //          (10–60s).
        //    Plus the iframe mount cascade (fetch codeUrl + dynamic
        //    import + react paint, 1–3s). 120s budget covers the
        //    p95 of that chain; smaller budgets flaked at ~60s on
        //    runs where Claude was on the slow side of its variance.
        const iframeLocator = page.locator(
          'iframe[data-ggui-mcp-app-iframe]',
        );
        await iframeLocator
          .first()
          .waitFor({ state: 'attached', timeout: 120_000 });

        // 3. Once the iframe is mounted, give the renderer a moment to
        //    boot the iframe-runtime and paint the contract.
        const iframeFrame = iframeLocator.first().contentFrame();
        if (!iframeFrame) {
          throw new Error('iframe contentFrame() returned null');
        }
        // The rendered todo UI should include the text "buy milk" — wait
        // for any element with that text to appear in the iframe. Same
        // 120s budget as the iframe-attach wait above — after attach,
        // the cold-gen + mount still has its tail.
        const buyMilk = iframeFrame.getByText(/buy milk/i).first();
        await buyMilk.waitFor({ state: 'visible', timeout: 120_000 });

        // 4. PRE-CLICK GUARD — verify state is still untouched. Guards
        //    against the false positive where the LLM preemptively
        //    toggled "buy milk" from the prompt alone, without the
        //    click actually flowing through the wire.
        const preClick = await fetchTodos();
        expect(
          preClick.every((t) => t.done === false),
          `pre-click state mutated; LLM toggled without input: ${JSON.stringify(preClick)}`,
        ).toBe(true);
        expect(
          preClick.some((t) => /buy milk/i.test(t.text)),
          'pre-click state missing "buy milk"',
        ).toBe(true);

        // 5. Click the checkbox for "buy milk". Prefer checkbox role
        //    (biases toward toggle intent); fall back to label or list-
        //    item ancestors if the LLM didn't use a proper checkbox.
        //    Buttons are deprioritized — they're more likely a delete.
        const clickTargets = [
          iframeFrame.getByRole('checkbox', { name: /buy milk/i }).first(),
          iframeFrame.locator('label').filter({ hasText: /buy milk/i }).first(),
          iframeFrame.getByRole('listitem').filter({ hasText: /buy milk/i }).first(),
          iframeFrame.getByRole('checkbox').first(),
          buyMilk,
        ];
        let clicked = false;
        for (const target of clickTargets) {
          try {
            const visible = await target.isVisible({ timeout: 1000 });
            if (!visible) continue;
            await target.click({ timeout: 5000 });
            clicked = true;
            break;
          } catch {
            /* try the next candidate */
          }
        }
        expect(clicked, 'no clickable "buy milk" element found in iframe').toBe(
          true,
        );

        // 6. Poll todo MCP admin state until the buy-milk row flips to
        //    done: true. The flow that must complete in this window:
        //      iframe click → submit_action → relay → ggui MCP pipe
        //      → mid-turn ggui_consume drains → LLM reasons + calls
        //      todo_toggle → todo MCP mutates store.
        const deadline = Date.now() + 120_000;
        let toggled = false;
        let lastSnapshot: ReadonlyArray<Todo> = [];
        while (Date.now() < deadline) {
          const todos = await fetchTodos();
          lastSnapshot = todos;
          const milk = todos.find((t) => /buy milk/i.test(t.text));
          if (milk && milk.done) {
            toggled = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!toggled) {
          // Surface a useful diagnostic when the round trip didn't
          // complete in budget.
          // eslint-disable-next-line no-console
          console.error(
            '[scenario-7] last admin/state snapshot:',
            JSON.stringify(lastSnapshot, null, 2),
          );
        }
        expect(toggled).toBe(true);

        // 7. Sanity: the other two todos remain `done: false` — we
        //    toggled exactly one, not all of them.
        const otherStillFalse = lastSnapshot.filter(
          (t) => !/buy milk/i.test(t.text) && t.done === false,
        );
        expect(otherStillFalse.length).toBe(2);

        // 8. WIRE-LEVEL EVIDENCE — read the SDK message tape captured
        //    by the addInitScript fetch wrapper. Verifies that the
        //    state mutation in (6) was actually caused by the click
        //    going through the wire (not by a side-channel like the
        //    LLM toggling preemptively from prompt-only reading).
        interface AnthropicContent {
          readonly type?: string;
          readonly name?: string;
          readonly input?: Record<string, unknown>;
          readonly content?: ReadonlyArray<{ text?: string }>;
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
        const toolNames = toolUses.map((u) => u.name).filter(Boolean);

        // The push wired the actionable UI into the wire.
        expect(
          toolNames.includes('mcp__ggui__ggui_push'),
          `expected ggui_push tool call; saw [${toolNames.join(', ')}]`,
        ).toBe(true);

        // The agent long-polled for the user's click via the pipe.
        expect(
          toolNames.includes('mcp__ggui__ggui_consume'),
          `expected ggui_consume tool call; saw [${toolNames.join(', ')}]`,
        ).toBe(true);

        // The agent reacted to the click by calling the domain tool on
        // the SECOND MCP. This is the cross-MCP proof.
        expect(
          toolNames.includes('mcp__todo__todo_toggle'),
          `expected todo_toggle tool call; saw [${toolNames.join(', ')}]`,
        ).toBe(true);

        // todo_toggle's input must carry the id of the buy-milk row.
        const buyMilkRow = lastSnapshot.find((t) =>
          /buy milk/i.test(t.text),
        );
        const toggleCall = toolUses.find(
          (u) => u.name === 'mcp__todo__todo_toggle',
        );
        expect(toggleCall?.input?.id).toBe(buyMilkRow?.id);

        // TODO (haiku-compliance work): assert the agent then calls
        // ggui_update with the refreshed todos AND the iframe DOM
        // reflects the new "done" state on buy-milk. Triad strengthening
        // alone wasn't enough to make haiku reliably emit the post-
        // mutation ggui_update — captured 2026-05-14, deferred behind
        // the planned ggui_update kind:'merge'|'replace' redesign +
        // synth keyed-map preference work.
      },
      300_000,
    );
  },
);
