/**
 * Agent-loop journey — Claude SDK.
 *
 * Workspace-mode mirror of `templates/claude-agent-sdk/tests/e2e/
 * chat-smoke.spec.ts`. Same 2 assertions, but here `@ggui-ai/*` is
 * workspace-linked — edit-to-validation is rebuild + run (~30s) instead
 * of the template path's build + republish-to-Verdaccio + reinstall
 * (~5min). Templates still own the publish-gate version of this story.
 *
 * Requires `ANTHROPIC_API_KEY` in the monorepo `.env.local` (the journey
 * playwright config loads it via dotenv). Skipped cleanly when absent.
 */
import { test, expect } from '@playwright/test';

import {
  HARNESS_PORTS,
  spawnAgentLoop,
  type AgentLoopHandle,
} from './agent-loop-harness';

const PROMPT =
  'Create a todo list with 3 items: buy milk, walk the dog, write code. Then show me the list.';
const EXPECTED_TODOS = ['buy milk', 'walk', 'write code'];

test.describe('agent loop — claude-agent-sdk (workspace mode)', () => {
  let handle: AgentLoopHandle | undefined;

  test.beforeAll(async () => {
    test.skip(
      !process.env.ANTHROPIC_API_KEY?.trim(),
      'set ANTHROPIC_API_KEY in monorepo .env.local',
    );
    handle = await spawnAgentLoop({ sdk: 'claude-agent-sdk' });
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
    await expect(page.getByRole('button', { name: /send/i })).toBeVisible();

    await input.fill(PROMPT);
    await page.getByRole('button', { name: /send/i }).click();

    // First-turn full generation: agent picks tools, ggui generates UI,
    // iframe loads. Up to 150s for a fresh blueprint match + LLM call.
    // 240s allows for a cold workspace boot (no precompiled blueprint
     // cache, fresh code-gen) + Haiku's full turn including all tool
     // calls. Templates' chat-smoke uses 150s because they hit the
     // pre-warmed Verdaccio path; workspace mode is consistently slower.
    await expect(page.getByText(/turn ended/i)).toBeVisible({
      timeout: 240_000,
    });

    const iframe = page.locator('iframe').first();
    await expect(iframe).toBeVisible({ timeout: 30_000 });

    const frame = page.frameLocator('iframe').first();

    // Negative-first: the "Setup needed" gate would mean the ggui server
    // didn't see an LLM key — that's a wiring bug, not LLM noise.
    await expect(
      frame.getByRole('heading', { name: /setup needed/i }),
    ).toHaveCount(0, { timeout: 60_000 });

    for (const todo of EXPECTED_TODOS) {
      await expect(
        frame.getByText(new RegExp(todo, 'i')).first(),
      ).toBeVisible({ timeout: 60_000 });
    }
  });

  test('preserves conversation context across turns (multi-turn resume)', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    if (!handle) throw new Error('handle not initialized');
    await page.goto(handle.agentUrl);
    const input = page.getByRole('textbox');
    const sendButton = page.getByRole('button', { name: /send/i });
    const turnEndedMarkers = page.getByText(/turn ended/i);

    // Turn 1 — establish stateful UI.
    await input.fill(
      'Build a simple counter UI starting at 0 with an Increment button.',
    );
    await sendButton.click();
    await expect(turnEndedMarkers).toHaveCount(1, { timeout: 180_000 });
    await expect(page.locator('iframe').first()).toBeVisible({
      timeout: 30_000,
    });

    // Turn 2 — state mutation. The agent must remember the counter.
    await input.fill('Set the counter to 5.');
    await sendButton.click();
    await expect(turnEndedMarkers).toHaveCount(2, { timeout: 180_000 });

    // "5" visible in the latest iframe. \b5\b avoids matching 15/50/0.5.
    await expect(
      page.frameLocator('iframe').last().getByText(/\b5\b/).first(),
    ).toBeVisible({ timeout: 60_000 });
  });
});

// Suppress unused-import lint on HARNESS_PORTS — it's re-exported here
// for spec authors who want to assert specific ports in custom flows.
void HARNESS_PORTS;
