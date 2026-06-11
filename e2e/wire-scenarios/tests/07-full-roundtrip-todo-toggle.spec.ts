/**
 * Scenario 7 — full LLM-to-LLM round-trip via the wire.
 *
 * Distinct from 1-5 (synthetic agent drives the wire boundary) and 6
 * (real LLM reaches the 2nd MCP, but no UI in the loop). Here BOTH
 * ends are a real LLM and the wire round-trip is exercised:
 *
 *   1. Pre-seed the todo MCP with 3 todos via `tools/call todo_add`.
 *   2. The user prompt rides the agent backend's own wire — `POST
 *      /auth/guest` → `POST /agent {kind:'chat', prompt}` SSE (since
 *      c711a9236 the sample agents are pure JSON backends; there is
 *      no chat textbox to type into — see fixtures/agent-driver.ts).
 *      The prompt asks the agent to render the todos with a toggle.
 *   3. Real LLM agent calls `todo_list` → `ggui_handshake` →
 *      `ggui_render`, rendering an interactive list.
 *   4. The test reads the render's `sessionId` + `resourceUri` off the
 *      SSE tape (`ggui_render`'s tool result), resolves the resource
 *      via MCP `resources/read` (the spec-canonical mount handle —
 *      the R5 retirement removed the `/r/<shortCode>` URL surface),
 *      and mounts it in a real browser behind the minimal MCP-Apps
 *      host stand-in (fixtures/mcp-app-host.ts: answers
 *      `ui/initialize`, relays iframe-issued `tools/call` to the ggui
 *      MCP — the host role claude.ai / the sample frontend play).
 *   5. Real user (Playwright) clicks the todo labelled "buy milk" in
 *      the rendered UI inside the host's iframe.
 *   6. The click → `submit_action` → host relay → pipe-append on the
 *      render-keyed pending-events pipe.
 *   7. The mid-turn LLM agent drains `ggui_consume`, reads the toggle
 *      event, and calls `todo_toggle({id: <the buy-milk id>})` on the
 *      todo MCP.
 *   8. Todo MCP mutates state. Test asserts on `/admin/state`.
 *
 * Every action is agent-routed: the click lands as an event on the
 * GguiSession's consume buffer and the agent decides which tool to
 * call next — `actionSpec[*].nextStep` is an advisory hint, nothing
 * more. The prompt nudges the LLM to drain `ggui_consume` mid-turn so
 * the toggle reaches the todo MCP within the same conversation.
 *
 * This is the canonical "real production scenario" pin: real user, real
 * LLM, real wire, real domain MCP, real state mutation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { callTool, readResource } from '../fixtures/mcp-client.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import {
  startMcpAppHost,
  type McpAppHostHandle,
} from '../fixtures/mcp-app-host.js';
import {
  mintGuestToken,
  spawnSampleAgent,
  startChat,
  toolNames,
  toolResultFor,
  toolUses,
  type SampleAgentHandle,
} from '../fixtures/agent-driver.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const TODO_PORT = Number.parseInt(process.env.TODO_PORT ?? '6782', 10);
// Distinct from scenario 6's agent ports (6790/6791/6792) — both specs
// spawn sample agents, and SIGTERM port-release isn't fast enough to
// reuse a port reliably when the suite runs back-to-back.
const SAMPLE_PORT = Number.parseInt(process.env.SAMPLE_PORT_7 ?? '6793', 10);
// Unique sandbox-proxy port (sample default is 7790; scenario 6 rows
// use 7795-7797) — a stale agent squatting the fixed default
// EADDRINUSE-kills the boot and latches the test onto a dead agent.
const SANDBOX_PORT = Number.parseInt(
  process.env.SANDBOX_PORT_7 ?? '7799',
  10,
);
const TODO_MCP = `http://localhost:${TODO_PORT}/mcp`;
const TODO_ADMIN = `http://localhost:${TODO_PORT}/admin`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

interface Todo {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: string;
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
    let sampleAgent: SampleAgentHandle | undefined;
    let handle: BrowserHandle;

    beforeAll(async () => {
      // Start every scenario from a clean slate; we re-seed in beforeEach.
      const reset = await fetch(`${TODO_ADMIN}/reset`, { method: 'POST' });
      expect(reset.ok).toBe(true);

      sampleAgent = await spawnSampleAgent({
        pkg: '@ggui-samples/agent-claude-sdk',
        port: SAMPLE_PORT,
        sandboxProxyPort: SANDBOX_PORT,
        gguiMcpUrl: `http://localhost:${GGUI_PORT}/mcp`,
        todoMcpUrl: TODO_MCP,
        adapterName: 'claude-agent-sdk',
        logLabel: 'sample-agent',
      });
    }, 60_000);

    afterAll(async () => {
      await sampleAgent?.stop();
    });

    beforeEach(async () => {
      // Empty + re-seed so each test starts identical.
      await fetch(`${TODO_ADMIN}/reset`, { method: 'POST' });
      await seedTodos(['buy milk', 'walk the dog', 'finish report']);
      // Relay OFF: the mcp-app-host wrapper page IS the host party
      // here (answers ui/initialize + relays tools/call). A second
      // relay on the outer window would double-deliver every click's
      // submit_action.
      handle = await openBrowser({ relayToolCallsToMcp: false });
    });

    afterEach(async () => {
      await handle.close();
    });

    test(
      'click "buy milk" in agent-rendered UI → agent calls todo_toggle → state flips',
      async () => {
        if (!sampleAgent) throw new Error('sample agent not booted');
        const { page } = handle;

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

        const token = await mintGuestToken(sampleAgent.baseUrl);
        const chat = await startChat({
          baseUrl: sampleAgent.baseUrl,
          token,
          prompt,
        });

        let host: McpAppHostHandle | undefined;
        try {
          // 2. Wait for a SUCCESSFUL `ggui_render` on the SSE tape and
          //    read the render's identity from its tool result. This
          //    scenario chains TWO real LLM calls in series:
          //      (a) the sample-agent's LLM picks `ggui_render` (5–30s),
          //      (b) ggui-default's cold-gen produces the component
          //          (10–60s; ggui_render blocks until codeReady).
          //    120s budget covers the p95 of that chain.
          const renderRef = await chat.waitFor(
            (messages) => {
              for (const use of toolUses(messages)) {
                if (!/(^|__)ggui_render$/.test(use.name)) continue;
                const result = toolResultFor(messages, use.id);
                if (result === undefined || result.isError === true) continue;
                const sid = result.structuredContent?.sessionId;
                const uri = result.structuredContent?.resourceUri;
                if (
                  typeof sid === 'string' &&
                  sid.length > 0 &&
                  typeof uri === 'string' &&
                  uri.length > 0
                ) {
                  return { sessionId: sid, resourceUri: uri };
                }
              }
              return undefined;
            },
            120_000,
            'successful ggui_render tool result with sessionId + resourceUri',
          );

          // 3. Resolve the render's MCP-App resource (the spec-canonical
          //    mount handle) and open it behind the minimal MCP-Apps
          //    host stand-in. Cold-gen already completed inside
          //    ggui_render, so the mount cascade (resource read + fetch
          //    codeUrl + dynamic import + react paint) is short in
          //    practice; the 120s budget is tail-insurance.
          const resource = await readResource(
            `http://localhost:${GGUI_PORT}/mcp`,
            renderRef.resourceUri,
          );
          const resourceHtml = resource.result?.contents?.[0]?.text;
          if (typeof resourceHtml !== 'string' || resourceHtml.length === 0) {
            throw new Error(
              `resources/read(${renderRef.resourceUri}) returned no text content: ` +
                JSON.stringify(resource).slice(0, 400),
            );
          }
          host = await startMcpAppHost({
            mcpUrl: `http://localhost:${GGUI_PORT}/mcp`,
            resourceHtml,
          });
          await page.goto(host.url, { waitUntil: 'networkidle' });
          const appFrame = page.frameLocator('iframe[data-ggui-mcp-app-iframe]');
          const buyMilk = appFrame.getByText(/buy milk/i).first();
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
            appFrame.getByRole('checkbox', { name: /buy milk/i }).first(),
            appFrame.locator('label').filter({ hasText: /buy milk/i }).first(),
            appFrame
              .getByRole('listitem')
              .filter({ hasText: /buy milk/i })
              .first(),
            appFrame.getByRole('checkbox').first(),
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
          expect(
            clicked,
            'no clickable "buy milk" element found in rendered UI',
          ).toBe(true);

          // 6. Poll todo MCP admin state until the buy-milk row flips to
          //    done: true. The flow that must complete in this window:
          //      click → submit_action → relay → ggui MCP pipe
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
              'tape tool calls:',
              toolNames(chat.messages),
              'streamError:',
              chat.streamError(),
            );
          }
          expect(toggled).toBe(true);

          // 7. Sanity: the other two todos remain `done: false` — we
          //    toggled exactly one, not all of them.
          const otherStillFalse = lastSnapshot.filter(
            (t) => !/buy milk/i.test(t.text) && t.done === false,
          );
          expect(otherStillFalse.length).toBe(2);

          // 8. WIRE-LEVEL EVIDENCE — read the SSE message tape from the
          //    `/agent` stream. Verifies that the state mutation in (6)
          //    was actually caused by the click going through the wire
          //    (not by a side-channel like the LLM toggling preemptively
          //    from prompt-only reading).
          const names = toolNames(chat.messages);

          // The render wired the actionable UI into the wire.
          expect(
            names.includes('mcp__ggui__ggui_render'),
            `expected ggui_render tool call; saw [${names.join(', ')}]`,
          ).toBe(true);

          // The agent long-polled for the user's click via the pipe.
          expect(
            names.includes('mcp__ggui__ggui_consume'),
            `expected ggui_consume tool call; saw [${names.join(', ')}]`,
          ).toBe(true);

          // The agent reacted to the click by calling the domain tool on
          // the SECOND MCP. This is the cross-MCP proof.
          expect(
            names.includes('mcp__todo__todo_toggle'),
            `expected todo_toggle tool call; saw [${names.join(', ')}]`,
          ).toBe(true);

          // todo_toggle's input must carry the id of the buy-milk row.
          const buyMilkRow = lastSnapshot.find((t) =>
            /buy milk/i.test(t.text),
          );
          const toggleCall = toolUses(chat.messages).find(
            (u) => u.name === 'mcp__todo__todo_toggle',
          );
          expect(toggleCall?.input.id).toBe(buyMilkRow?.id);

          // TODO (haiku-compliance work): assert the agent then calls
          // ggui_update with the refreshed todos AND the rendered DOM
          // reflects the new "done" state on buy-milk. Triad strengthening
          // alone wasn't enough to make haiku reliably emit the post-
          // mutation ggui_update — captured 2026-05-14, deferred behind
          // the planned ggui_update kind:'merge'|'replace' redesign +
          // synth keyed-map preference work.
        } finally {
          // End the agent's turn (it may still be long-polling
          // ggui_consume for further clicks) and reclaim the socket +
          // the host stand-in's port.
          chat.abort();
          await chat.done;
          await host?.close();
        }
      },
      300_000,
    );
  },
);
