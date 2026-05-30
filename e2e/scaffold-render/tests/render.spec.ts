/**
 * Sub-tier B — render scenario. Drives the SCAFFOLDED published app's web SPA
 * (the real product: `npx create-agentic-app` → Verdaccio cohort → `pnpm dev`)
 * and proves the agent renders a UI for a real prompt. This is the fidelity
 * target the workspace journeys can't reach: it exercises the shipped packages,
 * not workspace source.
 *
 * Currently targets claude-agent-sdk (the key-available, proven path). The
 * harness is SDK-parametric (`spawnScaffoldedApp({sdk})`); extending to
 * openai/google is a matter of supplying their agent keys — see README.
 */
import { test, expect } from '@playwright/test';
import { spawnScaffoldedApp, type ScaffoldAppHandle } from './scaffold-app-harness';

// The proven agent-loop journey prompt — known to drive a todo render. We
// assert only that a requested item appears (a render happened); the full
// toggle round-trip is the workspace agent-loop journey's job.
const JOURNEY_PROMPT =
  'Please use the todo MCP server to add these items to my todo list: ' +
  'buy milk, walk the dog, write code. Then show me my todo list as an ' +
  'interactive UI where I can click an item to mark it done.';

test.describe('scaffold-render: agent renders against the published scaffolded app', () => {
  let app: ScaffoldAppHandle | undefined;

  test.beforeAll(() => {
    test.skip(
      !process.env['ANTHROPIC_API_KEY']?.trim(),
      'set ANTHROPIC_API_KEY — sub-tier B drives a real LLM',
    );
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('claude-agent-sdk: chat → render → todo item visible', async ({ page }) => {
    // First test bears the one-time build+publish+assemble (ensureSetup) plus
    // scaffold+install+boot+LLM — generous budget for a nightly capstone.
    test.setTimeout(1_500_000);
    app = await spawnScaffoldedApp({ sdk: 'claude-agent-sdk' });

    await page.goto(app.webUrl);
    await page.getByRole('textbox').fill(JOURNEY_PROMPT);
    await page.getByRole('button', { name: /send/i }).click();

    // Double-iframe drill (outer sandbox-proxy → inner srcdoc) — mirrors agent-loop.spec.ts.
    const frame = page.frameLocator('iframe').first().frameLocator('iframe').first();

    // Behavior assertion: the requested item renders. retries:1 absorbs LLM variance.
    await expect(frame.getByText(/buy milk/i).first()).toBeVisible({ timeout: 240_000 });
  });
});
