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
 *
 * ## Obligation remapping (2026-06-11 retired-surfaces port)
 *
 * All assertions are UNCHANGED (toast text reaches the iframe DOM +
 * `ggui_emit` on channel `toast` appears on the tool tape). Two
 * surfaces moved:
 *
 *   - The prompt used to be typed into the sample frontend's chat
 *     textbox at `/` — since c711a9236 the sample agents are pure
 *     JSON backends. The prompt now rides the library's own wire
 *     (`POST /auth/guest` → `POST /agent {kind:'chat'}` SSE) via
 *     fixtures/agent-driver.ts, and the tool tape is read from the
 *     validated SSE stream instead of a page-injected fetch hook.
 *   - The iframe used to be discovered inside the sample frontend's
 *     page. The render's `resourceUri` is now read off the SSE tape
 *     (`ggui_render`'s tool result), resolved via `resources/read`,
 *     and mounted behind the minimal MCP-Apps host stand-in
 *     (fixtures/mcp-app-host.ts) — same pattern as scenario 07.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
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
// Own agent port — distinct from scenario 6's rows (6790/6792/6794)
// and scenario 7's 6793, since SIGTERM port-release isn't fast enough
// to reuse a port reliably when the suite runs back-to-back.
const SAMPLE_PORT = Number.parseInt(process.env.SAMPLE_PORT_14 ?? '6796', 10);
// Unique sandbox-proxy port (sample default is 7790; scenario 6 rows
// use 7795-7797, scenario 7 uses 7799).
const SANDBOX_PORT = Number.parseInt(
  process.env.SANDBOX_PORT_14 ?? '7798',
  10,
);
const TODO_MCP = `http://localhost:${TODO_PORT}/mcp`;
const TODO_ADMIN = `http://localhost:${TODO_PORT}/admin`;

interface Todo {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: string;
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

// SKIPPED 2026-05-14 (skip preserved through the 2026-06-11 retired-
// surfaces port — the reasons below are model/triad prerequisites, not
// surface retirement): this scenario asks the LLM to author a
// streamSpec.toast channel AND emit on it from the agent side AFTER a
// domain-tool toggle. Load-bearing prerequisites that are NOT yet
// pinned:
//   - haiku reliably extends the contract with streamSpec when prompted
//     (currently nondeterministic);
//   - the LLM-generated component subscribes to the streamSpec channel
//     correctly (the ui-gen triad's streamSpec authoring guidance is
//     thin — see triad audit follow-up);
//   - haiku calls ggui_emit after a domain-tool mutation (same model
//     ceiling as scenario 07's missing ggui_update).
// NOTE: the third original prerequisite — the planned ggui_update
// kind:'merge'|'replace' redesign — HAS since shipped (the update wire
// is the kind-discriminated union now), so the skip should be
// re-evaluated once the streamSpec triad reinforcement lands.
describe.skip(
  'Scenario 14 — agent-driven ggui_emit toast on toggle',
  () => {
    let sampleAgent: SampleAgentHandle | undefined;
    let handle: BrowserHandle;

    beforeAll(async () => {
      const reset = await fetch(`${TODO_ADMIN}/reset`, { method: 'POST' });
      expect(reset.ok).toBe(true);

      sampleAgent = await spawnSampleAgent({
        pkg: '@ggui-samples/agent-claude-sdk',
        port: SAMPLE_PORT,
        sandboxProxyPort: SANDBOX_PORT,
        gguiMcpUrl: `http://localhost:${GGUI_PORT}/mcp`,
        todoMcpUrl: TODO_MCP,
        adapterName: 'claude-agent-sdk',
        logLabel: 'sample-agent-14',
      });
    }, 60_000);

    afterAll(async () => {
      await sampleAgent?.stop();
    });

    beforeEach(async () => {
      await fetch(`${TODO_ADMIN}/reset`, { method: 'POST' });
      await seedTodos(['buy milk', 'walk the dog']);
      handle = await openBrowser();
    });

    afterEach(async () => {
      await handle.close();
    });

    test(
      'click → todo_toggle → agent emits toast on declared channel → iframe renders text',
      async () => {
        if (!sampleAgent) throw new Error('sample agent not booted');
        const { page } = handle;

        // Prompt steers the agent toward a contract with streamSpec.toast
        // AND nudges it to call ggui_emit after the toggle. Explicit
        // about both halves — the agent must declare the channel in the
        // contract AND emit on it for the test to pass.
        const prompt = [
          'Show me my todo list. Render each todo as a row with a checkbox',
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

        const token = await mintGuestToken(sampleAgent.baseUrl);
        const chat = await startChat({
          baseUrl: sampleAgent.baseUrl,
          token,
          prompt,
        });

        let host: McpAppHostHandle | undefined;
        try {
          // Wait for a SUCCESSFUL ggui_render on the SSE tape and read
          // the render's mount handle off its tool result (same pick as
          // scenario 07).
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

          // Resolve + mount the render's resource behind the host.
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
          await appFrame
            .getByText(/buy milk/i)
            .first()
            .waitFor({ state: 'visible', timeout: 120_000 });

          // Click "buy milk".
          const clickTargets = [
            appFrame.getByRole('checkbox', { name: /buy milk/i }).first(),
            appFrame.locator('label').filter({ hasText: /buy milk/i }).first(),
            appFrame.getByRole('listitem').filter({ hasText: /buy milk/i }).first(),
            appFrame.getByText(/buy milk/i).first(),
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
            try {
              const text = await appFrame
                .locator('body')
                .innerText({ timeout: 500 })
                .catch(() => '');
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

          // Wire-level evidence — ggui_emit was called on the toast
          // channel. Read from the validated SSE tool tape (the page-
          // injected fetch hook died with the chat textbox).
          const uses = toolUses(chat.messages);
          const emitCalls = uses.filter((u) => u.name === 'mcp__ggui__ggui_emit');
          expect(
            emitCalls.length,
            `expected at least one ggui_emit call; saw [${toolNames(chat.messages).join(', ')}]`,
          ).toBeGreaterThan(0);
          const toastEmits = emitCalls.filter((u) => u.input.channel === 'toast');
          expect(
            toastEmits.length,
            `expected ggui_emit on "toast" channel; channels seen: [${emitCalls.map((u) => String(u.input.channel)).join(', ')}]`,
          ).toBeGreaterThan(0);
        } finally {
          // End the agent's turn (it may still be long-polling
          // ggui_consume) and reclaim the socket + the host's port.
          chat.abort();
          await chat.done;
          await host?.close();
        }
      },
      300_000,
    );
  },
);
