/**
 * Scenario 6 — sample-agent + todo MCP real-data round trip.
 *
 * The flagship integration test. Exercises the full agent loop:
 *   1. User prompts: "add a todo: buy milk"
 *   2. Agent calls `todo_add` on the todo MCP → state mutates
 *
 * Real backing state assertion: read `/admin/state` on the todo MCP
 * AFTER the flow completes and confirm the new todo is present.
 *
 * Driven BROWSERLESSLY: since c711a9236 the sample agents are pure
 * JSON backends (no chat textbox at `/`), so the prompt rides the
 * library's own wire — `POST /auth/guest` → `POST /agent
 * {kind:'chat', prompt}` SSE (see fixtures/agent-driver.ts). The
 * assertions are unchanged (admin-state mutation + `todo_list`
 * cross-check); only the prompt-delivery mechanism moved.
 *
 * Parametric over the three reference agent SDKs — this is the
 * agent-framework axis of the e2e matrix. Each row spawns its own
 * sample agent against the matching ggui-default-<provider> instance
 * (booted by global-setup.ts), so a regression in any one SDK fails
 * exactly its row. Rows skip cleanly when their API key is missing;
 * set `GGUI_E2E_REQUIRE_ALL_PROVIDERS=1` to hard-fail instead (the
 * label-gated CI path).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { callTool } from '../fixtures/mcp-client.js';
import {
  mintGuestToken,
  spawnSampleAgent,
  startChat,
  toolNames,
  type SampleAgentHandle,
} from '../fixtures/agent-driver.js';

const TODO_PORT = Number.parseInt(process.env.TODO_PORT ?? '6782', 10);
const TODO_MCP = `http://localhost:${TODO_PORT}/mcp`;
const TODO_ADMIN = `http://localhost:${TODO_PORT}/admin`;
const REQUIRE_ALL = process.env.GGUI_E2E_REQUIRE_ALL_PROVIDERS === '1';

interface AgentRow {
  /** Display label for the describe block. */
  readonly sdk: string;
  /** Workspace package name spawned via `pnpm --filter`. */
  readonly pkg: string;
  /** Port the agent backend listens on. */
  readonly samplePort: number;
  /**
   * Sandbox-proxy port for the spawned agent. The samples ship FIXED
   * defaults (7790/7791/7792) — a stale agent from a prior run holding
   * its default port EADDRINUSE-kills the next boot, and the test then
   * latches onto the stale (ggui-torn-down) agent. Unique per-row
   * overrides away from the defaults dodge both.
   */
  readonly sandboxPort: number;
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
    sandboxPort: Number.parseInt(
      process.env.SANDBOX_PORT_CLAUDE ?? '7795',
      10,
    ),
    apiKey: 'ANTHROPIC_API_KEY',
    gguiPort: Number.parseInt(process.env.GGUI_PORT ?? '6781', 10),
  },
  {
    sdk: 'openai-agents-sdk',
    pkg: '@ggui-samples/agent-openai-sdk',
    // 6794, NOT the openai sample's 6791 default: 6791 was the
    // historic scenario-07 agent port, so stale claude agents from
    // old runs squat exactly there (observed live 2026-06-11 — the
    // squatter answered this row's probe while our own child died
    // with EADDRINUSE).
    samplePort: Number.parseInt(process.env.SAMPLE_PORT_OPENAI ?? '6794', 10),
    sandboxPort: Number.parseInt(
      process.env.SANDBOX_PORT_OPENAI ?? '7796',
      10,
    ),
    apiKey: 'OPENAI_API_KEY',
    gguiPort: Number.parseInt(process.env.GGUI_OPENAI_PORT ?? '6787', 10),
  },
  {
    sdk: 'google-adk',
    pkg: '@ggui-samples/agent-google-adk',
    samplePort: Number.parseInt(process.env.SAMPLE_PORT_GOOGLE ?? '6792', 10),
    sandboxPort: Number.parseInt(
      process.env.SANDBOX_PORT_GOOGLE ?? '7797',
      10,
    ),
    apiKey: 'GEMINI_API_KEY',
    gguiPort: Number.parseInt(process.env.GGUI_GOOGLE_PORT ?? '6788', 10),
  },
];

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

      let sampleAgent: SampleAgentHandle | undefined;

      beforeAll(async () => {
        // Reset todo MCP state — every scenario row boots from an empty list.
        const reset = await fetch(`${TODO_ADMIN}/reset`, { method: 'POST' });
        expect(reset.ok).toBe(true);

        // Each row points at the matching ggui-default-<provider>
        // instance so the full provider stack is exercised end-to-end
        // (agent SDK ↔ ggui server's cold-gen LLM both share the
        // same upstream LLM family per row).
        sampleAgent = await spawnSampleAgent({
          pkg: agent.pkg,
          port: agent.samplePort,
          sandboxProxyPort: agent.sandboxPort,
          gguiMcpUrl: `http://localhost:${agent.gguiPort}/mcp`,
          todoMcpUrl: TODO_MCP,
          // The row's sdk label IS the adapter name the backend
          // manifests — the driver uses it to reject stale-agent
          // port squatters.
          adapterName: agent.sdk,
          logLabel: agent.sdk,
        });
      }, 60_000);

      afterAll(async () => {
        await sampleAgent?.stop();
      });

      test(
        '"add a todo: buy milk" → agent calls todo_add → state mutates',
        async () => {
          if (!sampleAgent) throw new Error('sample agent not booted');
          const baseUrl = sampleAgent.baseUrl;

          const token = await mintGuestToken(baseUrl);
          const chat = await startChat({
            baseUrl,
            token,
            prompt: 'add a todo with the text "buy milk"',
          });

          try {
            // Poll todo MCP admin state until the new todo appears.
            const deadline = Date.now() + 90_000;
            let found = false;
            while (Date.now() < deadline) {
              const state = (await (
                await fetch(`${TODO_ADMIN}/state`)
              ).json()) as { todos: Array<{ text: string }> };
              if (
                state.todos.some((t) =>
                  t.text.toLowerCase().includes('buy milk'),
                )
              ) {
                found = true;
                break;
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
            if (!found) {
              // Surface what the agent actually did when the state
              // never mutated — the SSE tape names every tool call.
              // eslint-disable-next-line no-console
              console.error(
                `[scenario-6:${agent.sdk}] state never mutated; tape tool calls:`,
                toolNames(chat.messages),
                'streamError:',
                chat.streamError(),
              );
            }
            expect(found).toBe(true);

            // Cross-check via the todo MCP's tools/call surface.
            const list = await callTool(TODO_MCP, 'todo_list', {});
            const todos = (
              list.result?.structuredContent as {
                todos: Array<{ text: string }>;
              }
            ).todos;
            expect(
              todos.some((t) => t.text.toLowerCase().includes('buy milk')),
            ).toBe(true);
          } finally {
            // The agent may still be mid-turn (e.g. composing a render
            // after the mutation); the assertion target is the state
            // change, so end the turn and reclaim the socket.
            chat.abort();
            await chat.done;
          }
        },
        180_000,
      );
    },
  );
}
