/**
 * Agent-loop journey — single spec, matrix over 3 SDKs.
 *
 * Workspace-mode mirror of `templates/<sdk>/tests/e2e/chat-smoke.spec.ts`.
 * One file describing the full agent loop (render → ggui_consume →
 * tool → ggui_update), parameterized over claude-agent-sdk,
 * openai-agents-sdk, google-adk. A vanilla JS `for...of` loop
 * registers one `test.describe` per SDK; same 3 tests run against
 * each. Each SDK's describe is skipped cleanly when its BYOK key
 * is absent, so adding a new SDK is "add an entry to MATRIX".
 *
 * Templates exercise the PUBLISH gate (Verdaccio @ggui-ai/*@0.1.0-rc.3
 * → reinstall → run, ~5 min/cycle). This journey targets workspace:*
 * deps so a triad edit is one rebuild away from a live e2e signal.
 */
import { test, expect } from '@playwright/test';

import {
  HARNESS_PORTS,
  findTodoCheckedIndicator,
  findTodoToggleable,
  spawnAgentLoop,
  type AgentLoopHandle,
  type SdkId,
} from './agent-loop-harness';

interface MatrixEntry {
  readonly sdk: SdkId;
  readonly byokEnvVars: readonly string[];
  readonly byokInstruction: string;
}

const MATRIX: readonly MatrixEntry[] = [
  {
    sdk: 'claude-agent-sdk',
    byokEnvVars: ['ANTHROPIC_API_KEY'],
    byokInstruction: 'set ANTHROPIC_API_KEY in monorepo .env.local',
  },
  {
    sdk: 'openai-agents-sdk',
    byokEnvVars: ['OPENAI_API_KEY'],
    byokInstruction: 'set OPENAI_API_KEY in monorepo .env.local',
  },
  {
    sdk: 'google-adk',
    byokEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    byokInstruction:
      'set GEMINI_API_KEY (or GOOGLE_API_KEY) in monorepo .env.local',
  },
];

const TODO_PROMPT =
  'Render an interactive todo list UI with these 3 items: buy milk, walk the dog, write code. ' +
  'Show the list as a rendered UI component, not as a plain text reply.';
const EXPECTED_TODOS = ['buy milk', 'walk', 'write code'];

const CLICK_LOOP_PROMPT =
  'Create a todo list with 3 items: buy milk, walk the dog, write code. ' +
  'Make each item toggleable so I can click to mark it done. ' +
  'Keep listening for my clicks and update the UI in place when I toggle one.';

for (const entry of MATRIX) {
  test.describe(`agent loop - ${entry.sdk} (workspace mode)`, () => {
    let handle: AgentLoopHandle | undefined;

    test.beforeAll(async () => {
      const hasKey = entry.byokEnvVars.some((k) => process.env[k]?.trim());
      test.skip(!hasKey, entry.byokInstruction);
      handle = await spawnAgentLoop({ sdk: entry.sdk });
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test('agent renders an interactive UI with the 3 todos', async ({
      page,
    }) => {
      test.setTimeout(240_000);
      if (!handle) throw new Error('handle not initialized');
      await page.goto(handle.agentUrl);

      const input = page.getByRole('textbox');
      await expect(input).toBeVisible();
      await expect(
        page.getByRole('button', { name: /send/i }),
      ).toBeVisible();

      await input.fill(TODO_PROMPT);
      await page.getByRole('button', { name: /send/i }).click();

      // 240s allows for a cold workspace boot (no precompiled blueprint
      // cache, fresh code-gen) + the LLM's full turn including tools.
      await expect(page.getByText(/turn ended/i)).toBeVisible({
        timeout: 240_000,
      });

      const iframe = page.locator('iframe').first();
      await expect(iframe).toBeVisible({ timeout: 30_000 });

      // R5/spec-mig: `<AppRenderer>` mounts TWO iframes — an outer
      // sandbox-proxy iframe (serves `sandbox.html`, only carries the
      // postMessage relay) and an inner `srcdoc` iframe (carries the
      // LLM-generated UI). `frameLocator('iframe').first()` resolves to
      // the OUTER frame, which has no LLM output. Chain a second
      // `.frameLocator('iframe').first()` to drill into the inner frame
      // where the LLM-authored DOM actually lives.
      const frame = page
        .frameLocator('iframe')
        .first()
        .frameLocator('iframe')
        .first();
      await expect(
        frame.getByRole('heading', { name: /setup needed/i }),
      ).toHaveCount(0, { timeout: 60_000 });

      for (const todo of EXPECTED_TODOS) {
        await expect(
          frame.getByText(new RegExp(todo, 'i')).first(),
        ).toBeVisible({ timeout: 60_000 });
      }
    });

    test('session resume — closing + reopening the tab restores the prior iframe', async ({
      page,
    }) => {
      // What this test proves: the host-session resume slice
      // (`_meta["ai.ggui/host-session"]` capture at ggui_handshake,
      // `ggui_list_renders(hostName, hostSessionId)` enumeration,
      // /chat/restore bootstrap envelope replay) wires end-to-end.
      // After a page.reload() the iframe re-mounts with the same
      // rendered state, without a new agent turn.
      //
      // Mechanics:
      //   1. Open the page — URL gets redirected to `?chat=<chatId>`
      //      by `getOrCreateChatId`.
      //   2. Send a prompt → agent renders an iframe with known content.
      //   3. Capture the resolved URL (now carries `?chat=<id>`).
      //   4. page.reload() — same URL, fresh React tree, no /chat call.
      //   5. Frontend's on-mount /chat/restore returns the prior
      //      session's bootstrap envelope, iframe re-mounts.
      //   6. Assert the same content is back.
      test.setTimeout(360_000);
      if (!handle) throw new Error('handle not initialized');
      await page.goto(handle.agentUrl);

      const input = page.getByRole('textbox');
      const sendButton = page.getByRole('button', { name: /send/i });

      await input.fill(
        'Build a calculator UI showing the number 42 prominently. Just render it; no other interaction needed.',
      );
      await sendButton.click();
      await expect(page.getByText(/turn ended/i)).toBeVisible({
        timeout: 240_000,
      });

      // The agent renders an iframe; drill through the sandbox-proxy
      // pair to verify "42" is in the inner srcdoc.
      const beforeFrame = page
        .frameLocator('iframe')
        .first()
        .frameLocator('iframe')
        .first();
      await expect(beforeFrame.getByText(/\b42\b/).first()).toBeVisible({
        timeout: 120_000,
      });

      // Capture the resolved URL — must include the `?chat=` param
      // the frontend wrote so the reload-pass goes to the same chat.
      const resumeUrl = page.url();
      expect(resumeUrl).toContain('?chat=');

      // Hard reload — same URL, fresh DOM, no /chat call. The frontend
      // calls /chat/restore on mount and re-mounts the prior iframe.
      await page.reload();

      // Wait for the iframe to be visible after the reload — it has
      // to come from /chat/restore's bootstrap envelope, not a new
      // ggui_render (we never re-sent the prompt).
      const afterFrame = page
        .frameLocator('iframe')
        .first()
        .frameLocator('iframe')
        .first();
      await expect(afterFrame.getByText(/\b42\b/).first()).toBeVisible({
        timeout: 60_000,
      });
    });

    test('click on a todo propagates to the agent (live ggui_consume loop)', async ({
      page,
    }) => {
      // What this test proves: the agent's render → ggui_consume →
      // tool → ggui_update cycle is wired end-to-end. We do NOT send
      // a 2nd user prompt; the agent processes the click on its own
      // by polling ggui_consume. THE differentiator for ggui vs
      // "agent renders UI". See docs/principles/connector-architecture.md.
      test.setTimeout(360_000);
      if (!handle) throw new Error('handle not initialized');
      await page.goto(handle.agentUrl);

      const input = page.getByRole('textbox');
      const sendButton = page.getByRole('button', { name: /send/i });

      await input.fill(CLICK_LOOP_PROMPT);
      await sendButton.click();

      // Do NOT wait for "turn ended" — the agent is deliberately
      // alive on ggui_consume. Wait for the iframe to render instead.
      const iframeLocator = page.locator('iframe').first();
      await expect(iframeLocator).toBeVisible({ timeout: 120_000 });

      // R5/spec-mig: `<AppRenderer>` is a two-iframe sandbox-proxy host —
      // chain `.frameLocator('iframe').first()` twice to drill from the
      // outer proxy frame into the inner `srcdoc` frame where the
      // LLM-authored DOM lives.
      const firstFrame = page
        .frameLocator('iframe')
        .first()
        .frameLocator('iframe')
        .first();
      await expect(firstFrame.getByText(/buy milk/i).first()).toBeVisible({
        timeout: 120_000,
      });

      // Click using the harness helper — handles labeled-checkbox
      // (claude/openai pattern) AND unlabeled-checkbox-near-text
      // (gemini pattern). See findTodoToggleable's docstring.
      await findTodoToggleable(firstFrame, /buy milk/i).click({
        timeout: 30_000,
      });

      // Agent's active ggui_consume returns the event, agent calls
      // todo_toggle, then ggui_update-s. The agent may render an
      // intermediate state first (e.g. "Pending" while the todo MCP
      // call is in flight) and only transition to "Done" after the
      // tool returns — give it 180s to converge. Poll latest iframe
      // so this works whether the agent updated in place or pushed a
      // new view.
      // Double-drill again on the LATEST iframe pair to reach the
      // inner srcdoc where the agent's update lands.
      const latestFrame = page
        .frameLocator('iframe')
        .last()
        .frameLocator('iframe')
        .first();
      await expect(
        findTodoCheckedIndicator(latestFrame, /buy milk/i),
      ).toBeVisible({ timeout: 180_000 });
    });
  });
}

// Suppress unused-import lint on HARNESS_PORTS — re-exported here
// for spec authors who want to assert specific ports in custom flows.
void HARNESS_PORTS;
