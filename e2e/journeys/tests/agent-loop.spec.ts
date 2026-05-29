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

const JOURNEY_PROMPT =
  'Create a todo list with 3 items: buy milk, walk the dog, write code. ' +
  'Make each item toggleable so I can click to mark it done. ' +
  'Keep listening for my clicks and update the UI in place when I toggle one.';
const EXPECTED_TODOS = ['buy milk', 'walk', 'write code'];

for (const entry of MATRIX) {
  test.describe(`agent loop - ${entry.sdk} (workspace mode)`, () => {
    let handle: AgentLoopHandle | undefined;

    // eslint-disable-next-line no-empty-pattern
    test.beforeAll(async ({}, testInfo) => {
      const hasKey = entry.byokEnvVars.some((k) => process.env[k]?.trim());
      test.skip(!hasKey, entry.byokInstruction);
      // `testInfo.parallelIndex` is a stable 0-based per-worker
      // integer. Threaded into the harness so each worker binds its
      // own port set (see `portsForWorker` in agent-loop-harness.ts).
      // The `{}` destructure isn't optional — Playwright validates the
      // beforeAll signature and rejects underscore params.
      handle = await spawnAgentLoop({
        sdk: entry.sdk,
        workerIndex: testInfo.parallelIndex,
      });
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test('full journey: render → click → reload → click again', async ({
      page,
    }) => {
      // ONE session, three sequential steps. Replaces the prior
      // 3-tests-3-browser-sessions matrix with a single realistic
      // user journey. Cheaper (1 LLM render call per SDK instead of 3),
      // and strictly more powerful — step 3 validates that rehydration
      // preserves NON-TRIVIAL post-interaction state AND that the
      // click-loop survives a reload.
      //
      // Wall-clock budget: ~5 min per SDK (1 render + 2 click-loops +
      // 1 reload). Generous timeout in case of cold blueprint cache.
      test.setTimeout(600_000);
      if (!handle) throw new Error('handle not initialized');

      // -----------------------------------------------------------------
      // STEP 1 — initial render
      //   Sends the prompt, waits for the iframe to mount with the 3
      //   toggleable todos visible.
      // -----------------------------------------------------------------
      await page.goto(handle.agentUrl);
      await expect(page.getByRole('textbox')).toBeVisible();
      await page.getByRole('textbox').fill(JOURNEY_PROMPT);
      await page.getByRole('button', { name: /send/i }).click();

      // R5/spec-mig: `<AppRenderer>` is a two-iframe sandbox-proxy host —
      // chain `.frameLocator('iframe').first()` twice to drill from the
      // outer proxy frame into the inner `srcdoc` frame where the
      // LLM-authored DOM lives.
      const initialFrame = page
        .frameLocator('iframe')
        .first()
        .frameLocator('iframe')
        .first();
      for (const todo of EXPECTED_TODOS) {
        await expect(
          initialFrame.getByText(new RegExp(todo, 'i')).first(),
        ).toBeVisible({ timeout: 180_000 });
      }

      // -----------------------------------------------------------------
      // STEP 2 — click loop (toggle "buy milk" → checked)
      //   The agent is alive on ggui_consume; clicking dispatches an
      //   action it receives, calls todo_toggle, then ggui_update-s
      //   the render with the new checked state.
      // -----------------------------------------------------------------
      await findTodoToggleable(initialFrame, /buy milk/i).click({
        timeout: 30_000,
      });

      // The agent may transition through intermediate states (e.g.
      // "Pending") — poll the latest iframe pair for convergence.
      const afterFirstClickFrame = page
        .frameLocator('iframe')
        .last()
        .frameLocator('iframe')
        .first();
      await expect(
        findTodoCheckedIndicator(afterFirstClickFrame, /buy milk/i),
      ).toBeVisible({ timeout: 180_000 });

      // URL should now carry a `chat=<id>` query param — required
      // precondition for the reload-restore step below. Matches both
      // `?chat=` (only param) and `&chat=` (where the harness also
      // threaded a `?agent=<url>` runtime-config param at navigate
      // time — see `spawnAgentLoop`).
      expect(page.url()).toMatch(/[?&]chat=/);

      // -----------------------------------------------------------------
      // STEP 3 — reload + verify hydration + click again to undo
      //   3a. Hard reload — fresh React tree.
      //   3b. Frontend's on-mount GET /agent?chatId=X reads the stored
      //       snapshot which carries the POST-CLICK bootstrap (propsJson
      //       reflects the checked state).
      //   3c. Iframe re-mounts with the checked todo visible — proving
      //       the snapshot model captures post-interaction state, not
      //       just the initial render.
      //   3d. Click "buy milk" again to undo. Click loop must work
      //       post-rehydration (wsToken refresh via /api/renders/:id/state
      //       at iframe boot, fresh WS, ggui_consume still active).
      //   3e. Verify the checked indicator disappears.
      // -----------------------------------------------------------------
      await page.reload();

      const restoredFrame = page
        .frameLocator('iframe')
        .first()
        .frameLocator('iframe')
        .first();
      await expect(
        findTodoCheckedIndicator(restoredFrame, /buy milk/i),
      ).toBeVisible({ timeout: 60_000 });

      await findTodoToggleable(restoredFrame, /buy milk/i).click({
        timeout: 30_000,
      });

      // After the undo click loop, the checked indicator on "buy milk"
      // should disappear. Use the latest iframe pair again to catch any
      // re-mount the agent might do mid-update.
      const afterUndoFrame = page
        .frameLocator('iframe')
        .last()
        .frameLocator('iframe')
        .first();
      await expect(
        findTodoCheckedIndicator(afterUndoFrame, /buy milk/i),
      ).toHaveCount(0, { timeout: 180_000 });
    });
  });
}

// Suppress unused-import lint on HARNESS_PORTS — re-exported here
// for spec authors who want to assert specific ports in custom flows.
void HARNESS_PORTS;
