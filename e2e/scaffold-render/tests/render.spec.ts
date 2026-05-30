/**
 * Sub-tier B — render scenario, across all three agent SDKs. Drives the
 * SCAFFOLDED published app's web SPA (the real product: `npx create-agentic-app`
 * → Verdaccio cohort → `pnpm dev`) and proves the agent renders a UI for a real
 * prompt. This is the fidelity target the workspace journeys can't reach: it
 * exercises the shipped packages, not workspace source.
 *
 * One describe per SDK. ggui's own UI generation always needs ANTHROPIC_API_KEY;
 * each agent additionally needs its own key (OpenAI / Gemini). A missing key
 * skips that SDK's describe rather than failing it.
 */
import { test, expect } from '@playwright/test';
import { spawnScaffoldedApp, type ScaffoldAppHandle, type SdkId } from './scaffold-app-harness';

// The proven agent-loop journey prompt — known to drive a todo render. We
// assert only that a requested item appears (a render happened); the full
// toggle round-trip is the workspace agent-loop journey's job.
const JOURNEY_PROMPT =
  'Please use the todo MCP server to add these items to my todo list: ' +
  'buy milk, walk the dog, write code. Then show me my todo list as an ' +
  'interactive UI where I can click an item to mark it done.';

interface SdkCase {
  readonly sdk: SdkId;
  /** The agent backend's own key env var (ggui generation always needs ANTHROPIC). */
  readonly agentKeyVar: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY';
}

const SDK_CASES: readonly SdkCase[] = [
  { sdk: 'claude-agent-sdk', agentKeyVar: 'ANTHROPIC_API_KEY' },
  { sdk: 'openai-agents-sdk', agentKeyVar: 'OPENAI_API_KEY' },
  { sdk: 'google-adk', agentKeyVar: 'GEMINI_API_KEY' },
];

/** True when the agent's key is present (google-adk also accepts GOOGLE_API_KEY). */
function hasAgentKey(c: SdkCase): boolean {
  if (process.env[c.agentKeyVar]?.trim()) return true;
  if (c.sdk === 'google-adk' && process.env['GOOGLE_API_KEY']?.trim()) return true;
  return false;
}

for (const c of SDK_CASES) {
  test.describe(`scaffold-render: ${c.sdk} renders against the published scaffolded app`, () => {
    let app: ScaffoldAppHandle | undefined;

    test.beforeAll(() => {
      if (!process.env['ANTHROPIC_API_KEY']?.trim()) {
        test.skip(true, 'ANTHROPIC_API_KEY required (drives ggui UI generation for every SDK)');
        return;
      }
      test.skip(!hasAgentKey(c), `set ${c.agentKeyVar} for ${c.sdk}`);
    });

    test.afterAll(async () => {
      if (app) await app.close();
    });

    test(`${c.sdk}: chat → render → todo item visible`, async ({ page }) => {
      // First test bears the one-time build+publish+assemble (ensureSetup) plus
      // scaffold+install+boot+LLM — generous budget for a nightly capstone.
      test.setTimeout(1_500_000);
      app = await spawnScaffoldedApp({ sdk: c.sdk });

      // The web SPA resolves its agent endpoint from `?agent=` FIRST (App.tsx),
      // so pass the SDK's agent URL explicitly — `dev:web` runs plain vite,
      // which never reads the app-root .env.local, so VITE_AGENT_ENDPOINT_URL
      // alone would leave the web defaulting to 6790 (wrong for openai/google).
      await page.goto(`${app.webUrl}/?agent=${encodeURIComponent(app.agentUrl)}`);
      // Fast-fail on the static chat shell (90s) rather than the 25-min test
      // timeout — an unreachable agent / blank page should fail quickly.
      await page.getByRole('textbox').fill(JOURNEY_PROMPT, { timeout: 90_000 });
      await page.getByRole('button', { name: /send/i }).click();

      // Double-iframe drill (outer sandbox-proxy → inner srcdoc) — the scaffolded
      // app's apps/web IS ggui-basic-web + <AppRenderer>, same as agent-loop.spec.
      const frame = page.frameLocator('iframe').first().frameLocator('iframe').first();

      // Behavior assertion: the requested item renders. retries:1 absorbs LLM variance.
      await expect(frame.getByText(/buy milk/i).first()).toBeVisible({ timeout: 240_000 });
    });
  });
}
