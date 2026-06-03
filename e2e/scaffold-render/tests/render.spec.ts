/**
 * Sub-tier B — full agent-loop journey, across all three agent SDKs, against the
 * SCAFFOLDED published app (`npx create-agentic-app` → Verdaccio cohort →
 * `pnpm dev`). This is the highest-fidelity gate: it exercises the SHIPPED
 * packages, not workspace source, through the complete interactive loop:
 *
 *   render   — agent generates a todo UI; the 3 items mount in the iframe.
 *   interact — click "buy milk" → the agent drains the action (ggui_consume),
 *              toggles via the todo MCP, and ggui_update-s the checked state.
 *   rehydrate— reload the page → the on-mount snapshot restores the POST-CLICK
 *              checked state (not just the initial render).
 *
 * Mirrors the workspace `agent-loop.spec.ts` journey, but driven against the
 * scaffolded published app. One describe per SDK; ggui's UI generation always
 * needs ANTHROPIC_API_KEY, each agent needs its own key (OpenAI / Gemini); a
 * missing key skips that SDK.
 */
import { test, expect } from '@playwright/test';
import { spawnScaffoldedApp, type ScaffoldAppHandle, type SdkId } from './scaffold-app-harness';
// Toggleable/checked locators for agent-authored todo UIs (pure Playwright
// locator builders). Self-contained in scaffold-render — see ./todo-locators.
import { findTodoToggleable, findTodoCheckedIndicator } from './todo-locators';

// The proven agent-loop prompt — the trailing "keep in sync" sentence is what
// drives the click-loop (toggle → todo MCP update → ggui_update).
const JOURNEY_PROMPT =
  'Please use the todo MCP server to add these items to my todo list: ' +
  'buy milk, walk the dog, write code. Then show me my todo list as an ' +
  'interactive UI where I can click an item to mark it done. When I toggle ' +
  'an item, update it in the todo MCP so my list stays in sync.';

const EXPECTED_TODOS = ['buy milk', 'walk', 'write code'];

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
  test.describe(`scaffold-render: ${c.sdk} full journey against the published scaffolded app`, () => {
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

    test(`${c.sdk}: render → click → reload (rehydrate)`, async ({ page }) => {
      // First test bears the one-time build+publish+assemble (ensureSetup) plus
      // scaffold+install+boot+LLM — generous budget for a nightly capstone.
      test.setTimeout(1_500_000);
      app = await spawnScaffoldedApp({ sdk: c.sdk });

      // ── STEP 1 — render ──────────────────────────────────────────────
      // The web SPA resolves its agent endpoint from `?agent=` FIRST (App.tsx),
      // so pass it explicitly (`dev:web` runs plain vite, which never reads the
      // app-root .env.local).
      await page.goto(`${app.webUrl}/?agent=${encodeURIComponent(app.agentUrl)}`);
      // Fast-fail on the static chat shell (90s) rather than the test timeout.
      await expect(page.getByRole('textbox')).toBeVisible({ timeout: 90_000 });
      await page.getByRole('textbox').fill(JOURNEY_PROMPT);
      await page.getByRole('button', { name: /send/i }).click();

      // Double-iframe drill (outer sandbox-proxy → inner srcdoc): the scaffolded
      // app's apps/web IS ggui-basic-web + <AppRenderer>, same as agent-loop.spec.
      const initialFrame = page.frameLocator('iframe').first().frameLocator('iframe').first();
      for (const todo of EXPECTED_TODOS) {
        await expect(initialFrame.getByText(new RegExp(todo, 'i')).first()).toBeVisible({
          timeout: 240_000,
        });
      }

      // ── STEP 2 — interaction (toggle "buy milk" → checked) ───────────
      // Clicking dispatches an action the agent drains (ggui_consume), toggles
      // via the todo MCP, then ggui_update-s the render with the checked state.
      await findTodoToggleable(initialFrame, /buy milk/i).click({ timeout: 30_000 });
      // The agent may re-mount mid-update — read the LATEST iframe pair.
      const afterClickFrame = page.frameLocator('iframe').last().frameLocator('iframe').first();
      await expect(findTodoCheckedIndicator(afterClickFrame, /buy milk/i)).toBeVisible({
        timeout: 180_000,
      });
      // The chat id must be in the URL — precondition for the reload-restore step.
      expect(page.url()).toMatch(/[?&]chat=/);

      // ── STEP 3 — rehydration (reload → checked state persists) ───────
      // A hard reload re-mounts a fresh React tree; the on-mount snapshot must
      // restore the POST-CLICK checked state, proving the snapshot captures
      // post-interaction state — not just the initial render. This is the
      // rehydration assertion; we deliberately stop here (a further undo-click
      // would re-introduce LLM/UI non-determinism via a negative "checked-gone"
      // assertion — the workspace agent-loop journey owned that extra step).
      await page.reload();
      const restoredFrame = page.frameLocator('iframe').first().frameLocator('iframe').first();
      await expect(findTodoCheckedIndicator(restoredFrame, /buy milk/i)).toBeVisible({
        timeout: 60_000,
      });

      // --- Slice 1 measurement (best-effort; LOG ONLY, never gates) ---
      // What did this SDK author for each tool's serverInfo.name? canonical =
      // the real initialize name; config-key = the mcp__<server>__ prefix handle
      // (the nudge's intended output); fabricated = neither (what we want gone);
      // omitted = no name. Propagation of the ggui server's stderr to stdout() is
      // unverified — absence is logged, not asserted.
      const AGENTCAPS_TRUTH = { realName: '@ggui-samples/mcp-todo', configKey: 'todo' };
      const classifyAgentCap = (name: string | undefined): string =>
        name === undefined
          ? 'omitted'
          : name === AGENTCAPS_TRUTH.realName
            ? 'canonical'
            : name === AGENTCAPS_TRUTH.configKey
              ? 'config-key'
              : 'fabricated';
      const agentcapsLines = app
        .stdout()
        .split('\n')
        .filter((l) => l.includes('[ggui:agentcaps]'));
      if (agentcapsLines.length === 0) {
        // eslint-disable-next-line no-console -- measurement output for the run log.
        console.warn(
          `[agentcaps:${c.sdk}] no measurement lines captured (dev.mjs stderr forwarding gap?) — skipping classification`,
        );
      } else {
        for (const line of agentcapsLines) {
          const m = /tool=(\S+) serverInfo\.name=(\S+)/.exec(line);
          if (!m) continue;
          const authored = m[2] === '-' ? undefined : m[2];
          // eslint-disable-next-line no-console -- measurement output for the run log.
          console.log(
            `[agentcaps:${c.sdk}] tool=${m[1]} authored=${m[2]} class=${classifyAgentCap(authored)}`,
          );
        }
      }
    });
  });
}
