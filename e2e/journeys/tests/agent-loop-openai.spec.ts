/**
 * Agent-loop journey — OpenAI Agents SDK. Workspace-mode mirror of
 * `templates/openai-agents-sdk/tests/e2e/chat-smoke.spec.ts`.
 * See `./agent-loop-claude.spec.ts` for the design rationale.
 *
 * Requires `OPENAI_API_KEY`.
 */
import { test, expect } from '@playwright/test';

import {
  spawnAgentLoop,
  type AgentLoopHandle,
} from './agent-loop-harness';

const PROMPT =
  'Create a todo list with 3 items: buy milk, walk the dog, write code. Then show me the list.';
const EXPECTED_TODOS = ['buy milk', 'walk', 'write code'];

test.describe('agent loop — openai-agents-sdk (workspace mode)', () => {
  let handle: AgentLoopHandle | undefined;

  test.beforeAll(async () => {
    test.skip(
      !process.env.OPENAI_API_KEY?.trim(),
      'set OPENAI_API_KEY in monorepo .env.local',
    );
    handle = await spawnAgentLoop({ sdk: 'openai-agents-sdk' });
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

    await expect(page.getByText(/turn ended/i)).toBeVisible({
      timeout: 150_000,
    });

    const iframe = page.locator('iframe').first();
    await expect(iframe).toBeVisible({ timeout: 30_000 });

    const frame = page.frameLocator('iframe').first();
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

    await input.fill(
      'Build a simple counter UI starting at 0 with an Increment button.',
    );
    await sendButton.click();
    await expect(turnEndedMarkers).toHaveCount(1, { timeout: 180_000 });
    await expect(page.locator('iframe').first()).toBeVisible({
      timeout: 30_000,
    });

    await input.fill('Set the counter to 5.');
    await sendButton.click();
    await expect(turnEndedMarkers).toHaveCount(2, { timeout: 180_000 });

    await expect(
      page.frameLocator('iframe').last().getByText(/\b5\b/).first(),
    ).toBeVisible({ timeout: 60_000 });
  });
});
