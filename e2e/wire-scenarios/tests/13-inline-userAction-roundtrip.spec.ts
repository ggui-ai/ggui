/**
 * Scenario 13 — inline userAction round-trip via the chat shell.
 *
 * Scenario 7 covers the QUEUED path (pipe alive → consume drains
 * mid-turn). This scenario covers the INLINE path: the pipe is GONE
 * (popped) when the user clicks, so the iframe-runtime degrades to
 * `_meta.ggui.userAction.kind: 'inline'` on a `ui/message` envelope
 * carrying `{actionData, uiContext}`. The sample-agent's chat shell
 * intercepts the envelope, populates the prompt input, and the user
 * presses Send. The agent reads the prepared prompt + acts on it.
 *
 * The key claim under test: the iframe's "invisible" gesture payload
 * (actionData + uiContext) actually reaches the agent and drives a
 * correct domain-tool call PLUS a UI refresh. Scenario 2 pinned the
 * envelope shape at the iframe boundary; this one closes the loop
 * end-to-end with a real LLM on the receiving side.
 *
 * Test choreography:
 *   1. Pre-seed todos via `todo_add`.
 *   2. Prompt the sample agent to render the list with checkboxes.
 *   3. Wait for the iframe to mount (cold-gen + paint).
 *   4. POP the stack item — closes the server-side pipe.
 *   5. Click "buy milk" — iframe-runtime fires submit_action; server
 *      returns success but `consumerPresent` is moot (pipe gone) so
 *      classifySubmitActionResponse returns 'fallback', and the runtime
 *      emits an inline userAction envelope.
 *   6. The chat shell populates the prompt textbox (does NOT auto-send
 *      per the spec — `ui/message` is a PREPARED prompt). Test asserts
 *      the textbox now holds a prompt + clicks Send.
 *   7. Agent processes the prompt, calls `todo_toggle` with the
 *      buy-milk id, then re-renders.
 *   8. Assert: todo state mutated AND the agent did NOT call
 *      `ggui_consume` for the popped stack item (proving the inline
 *      payload was the carrier, not the pipe).
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
// Distinct port so the suite can run alongside scenarios 6/7 (each
// spawn their own sample-agent and SIGTERM port-release isn't fast
// enough to reuse).
const SAMPLE_PORT = Number.parseInt(process.env.SAMPLE_PORT_13 ?? '6792', 10);
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
    } catch {
      /* not ready yet */
    }
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

async function fetchTodos(): Promise<ReadonlyArray<Todo>> {
  const resp = await fetch(`${TODO_ADMIN}/state`);
  const data = (await resp.json()) as { todos: Todo[] };
  return data.todos;
}

// SKIPPED 2026-05-14: this scenario stresses the FULL inline carrier
// loop end-to-end with a real LLM on the receiving side, including
// post-mutation ggui_update. Pre-requisites that are NOT yet in place:
//   - haiku reliably calls ggui_update after a domain-tool mutation
//     (currently flaky even with the strengthened triad — see TODO
//     in scenario 07);
//   - the sample-agent's chat shell auto-forwards the inline userAction
//     prompt instead of requiring a manual Send press (currently it
//     just populates the textbox);
//   - the LLM understands the inline userAction envelope shape well
//     enough to extract `actionData.id` for the domain-tool call.
// Wire shape for `kind:'inline'` is already pinned by scenario 02 at
// the iframe boundary; this scenario adds the agent-side proof which
// will land after the ggui_update kind:'merge'|'replace' redesign +
// triad reinforcement + chat-shell auto-forward decision.
describe.skip(
  'Scenario 13 — inline userAction round-trip (pipe gone, payload travels on ui/message)',
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
      'pop the stack mid-flow → click → inline userAction → agent acts → state flips + UI re-renders',
      async () => {
        const { page } = handle;

        // Capture SDK tape for the tool-tape assertions at the end.
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

        // 1. Render the list — same prompt shape as scenario 7.
        const promptBox = page.getByRole('textbox').first();
        await promptBox.fill(
          [
            'Show me my todo list. Render each todo as a row with a checkbox',
            "in front of the todo's text. When I click a checkbox, mark that",
            'todo as done (or un-done) using the todo_toggle tool, then',
            're-render the list with ggui_update or ggui_push so I can see',
            'the new state. No delete buttons, no other controls.',
          ].join(' '),
        );
        await page.getByRole('button', { name: /^send$/i }).click();

        // 2. Wait for the iframe to mount with "buy milk" visible.
        const iframeLocator = page.locator('iframe[data-ggui-mcp-app-iframe]');
        await iframeLocator.first().waitFor({ state: 'attached', timeout: 120_000 });
        const iframeFrame = iframeLocator.first().contentFrame();
        if (!iframeFrame) throw new Error('iframe contentFrame() returned null');
        await iframeFrame
          .getByText(/buy milk/i)
          .first()
          .waitFor({ state: 'visible', timeout: 120_000 });

        // 3. Resolve the active session + stack item via ggui_get_session
        //    so we can pop it externally. The sample agent runs in a
        //    separate process; we can't read its in-memory session id
        //    directly, but `ggui_get_session` on a known sessionId is
        //    only useful if we knew it — we don't. Workaround: probe
        //    `_meta.ggui.bootstrap` from the iframe's window global.
        const stackItemId = await iframeFrame.locator('html').evaluate(() => {
          const w = window as unknown as {
            __GGUI_META__?: { stackItemId?: string; sessionId?: string };
          };
          return w.__GGUI_META__?.stackItemId ?? null;
        });
        const sessionId = await iframeFrame.locator('html').evaluate(() => {
          const w = window as unknown as {
            __GGUI_META__?: { stackItemId?: string; sessionId?: string };
          };
          return w.__GGUI_META__?.sessionId ?? null;
        });
        expect(stackItemId, 'iframe bootstrap missing stackItemId').toBeTruthy();
        expect(sessionId, 'iframe bootstrap missing sessionId').toBeTruthy();

        // 4. Wait for the agent's first turn to end so its in-flight
        //    `ggui_consume` long-poll terminates BEFORE we pop. If we
        //    pop while consume is still long-polling, the pop's
        //    markDeleted will short-circuit the poll and the agent
        //    will land back in the SDK loop ready for the next turn —
        //    but it ALSO blurs the "pipe-gone" assertion (the agent
        //    may have already drained an earlier event). Wait for the
        //    sentinel turn-end marker the chat shell emits.
        await page.locator('[data-testid="turn-end"]').first().waitFor({
          state: 'attached',
          timeout: 60_000,
        });

        // 5. POP — this is the "pipe gone" setup. markDeleted fires
        //    server-side, so the next submit_action for this stackItemId
        //    will land outside the active pipe window. The iframe is
        //    still mounted in the DOM (the pop only affects server-side
        //    routing, not iframe lifecycle).
        await callTool(`http://localhost:${GGUI_PORT}/mcp`, 'ggui_pop', {
          sessionId: sessionId!,
        });

        // 6. PRE-CLICK GUARD — state must still be untouched.
        const preClick = await fetchTodos();
        expect(
          preClick.every((t) => !t.done),
          `pre-click state mutated: ${JSON.stringify(preClick)}`,
        ).toBe(true);

        // 7. Click "buy milk". The runtime sends submit_action; the
        //    server returns a non-success outcome (pipe gone), the
        //    classifier returns 'fallback', and `emitUserActionInline`
        //    fires with full payload (actionData + uiContext).
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

        // 8. The chat shell intercepts the inline userAction's
        //    `ui/message` and populates the prompt textbox WITHOUT
        //    auto-sending. Poll the textbox value until it's non-empty,
        //    then press Send to forward the gesture as a fresh turn.
        const sendButton = page.getByRole('button', { name: /^send$/i });
        const promptTextarea = page.getByRole('textbox').first();
        const textboxDeadline = Date.now() + 15_000;
        let prepared = '';
        while (Date.now() < textboxDeadline) {
          const val = await promptTextarea.inputValue().catch(() => '');
          if (val && val.trim().length > 0) { prepared = val.trim(); break; }
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(
          prepared.length,
          'chat shell never populated the prompt textbox from the inline userAction',
        ).toBeGreaterThan(0);

        // The natural-language describe step should at least name the
        // intent. Looser regex on /save|toggle|click|check|buy milk/
        // tolerates the iframe-runtime's free-form prompt builder.
        expect(prepared).toMatch(/save|toggle|click|check|buy milk/i);

        await sendButton.click();

        // 9. Poll for the state flip. Same flow as scenario 7 from
        //    here on, just via the inline carrier instead of consume.
        const flipDeadline = Date.now() + 120_000;
        let toggled = false;
        let lastSnapshot: ReadonlyArray<Todo> = [];
        while (Date.now() < flipDeadline) {
          const todos = await fetchTodos();
          lastSnapshot = todos;
          const milk = todos.find((t) => /buy milk/i.test(t.text));
          if (milk?.done) { toggled = true; break; }
          await new Promise((r) => setTimeout(r, 1000));
        }
        expect(toggled, `state never flipped; last: ${JSON.stringify(lastSnapshot)}`).toBe(
          true,
        );

        // 10. Wire-level evidence. Read the SDK tape — collect tool
        //     calls from BOTH the first turn (render) and the second
        //     turn (act on the prepared prompt). The inline carrier
        //     proof: NO `ggui_consume` call was issued for the popped
        //     stackItemId on the second turn (the agent acted on the
        //     text prompt, not by draining the pipe).
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
        const toolNames = toolUses.map((u) => u.name).filter(Boolean);

        // First turn pushed the list; second turn toggled.
        expect(
          toolNames.includes('mcp__todo__todo_toggle'),
          `expected todo_toggle on the inline-prompted turn; saw [${toolNames.join(', ')}]`,
        ).toBe(true);

        // The toggled id must match the buy-milk row — proves the
        // inline `actionData` (or its prompt-rendered form) carried
        // enough identity to disambiguate the row.
        const buyMilkRow = lastSnapshot.find((t) => /buy milk/i.test(t.text));
        const toggleCall = toolUses.find((u) => u.name === 'mcp__todo__todo_toggle');
        expect(toggleCall?.input?.id).toBe(buyMilkRow?.id);

        // Inline-carrier proof — the agent did NOT drain the pipe for
        // the popped stack item. ggui_consume calls targeting the
        // popped stackItemId would mean the agent fell back on the
        // queued path instead of the inline payload.
        const consumeCallsForPopped = toolUses.filter(
          (u) =>
            u.name === 'mcp__ggui__ggui_consume' &&
            (u.input as { stackItemId?: string } | undefined)?.stackItemId === stackItemId,
        );
        expect(
          consumeCallsForPopped.length,
          'agent drained the popped pipe — inline carrier was NOT the path taken',
        ).toBe(0);
      },
      300_000,
    );
  },
);
