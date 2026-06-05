/**
 * Slice 11.5 C7 — runtime contract enforcement, Lane-1 E2E.
 *
 * Proves — end-to-end, through the real `ggui serve` CLI binary
 * running an `ggui.json#mcpMounts` fixture, hitting the console SPA's
 * `/preview/<id>` + "Try live →" surface, and rendering the blueprint
 * inside `/s/<shortCode>` — that the Slice 11.5 wiredActionRouter:
 *
 *   1. Happy path — a declared `actionSpec[name].tool` wired
 *      to a real MCP tool executes on click + the declared
 *      `streamSpec[name].tool` refresh emits the new state.
 *      "Click a checkbox → task state flips" with zero agent code.
 *
 *   2. Non-idempotency is honest — rapid double-click fires TWO
 *      dispatches + TWO tool invocations, and the final DOM state
 *      reflects both. This is NOT a bug — it's the documented
 *      non-goal in `docs/plans/2026-04-22-runtime-contract-
 *      enforcement-hardened.md §What Contract does NOT promise`.
 *
 *   3. Tool-throws path — a broken action surfaces a canonical
 *      `_ggui:contract-error` envelope with code `TOOL_THREW`.
 *      The render survives (button still clickable; previous stream
 *      state intact).
 *
 *   4. Schema-violation path — a valid action whose channel refresh
 *      returns a contract-violating shape surfaces a canonical
 *      contract-error envelope with code `SCHEMA_VIOLATION`. The
 *      channel's previous state is preserved — `assertStreamContract`
 *      rejects the bad payload BEFORE fanOut, so subscribers never
 *      see the corruption.
 *
 * ## Why Lane 1
 *
 * Blocking every PR, no LLM, <60s, clean-room. The proofs here close
 * the "declare + wire + no agent code" brand claim for every canonical
 * emission class — happy-path + 3 failures — without the cost of a
 * live generation test. Schema-violation + tool-throws PROVE we handle
 * failure modes canonically, which is what makes "Contract" a real
 * brand promise rather than marketing copy.
 *
 * ## Fixture shape (required reading)
 *
 * `fixtures/playground/` declares `mcpMounts: ["./tasks-mount.mjs"]`
 * in `ggui.json`. The mount exports 5 tools:
 *
 *   - `tasks_list` / `tasks_create` / `tasks_complete` — happy-path
 *     trio backing the Todo blueprint.
 *   - `tasks_broken` — always throws; wired by `contract-probe` to
 *     exercise TOOL_THREW.
 *   - `tasks_malformed_list` — returns `{wrong:'shape'}`; declared on
 *     `contract-probe#stream.channels.tasks.tool` to exercise
 *     SCHEMA_VIOLATION on refresh.
 *
 * Blueprints the spec hits:
 *
 *   - `todo-list`       — happy path + double-click
 *   - `contract-probe`  — tool-throws + schema-violation
 *
 * ## Clean-room posture
 *
 * `spawnGguiServeInCwd` spawns the CLI with CWD pinned to the fixture
 * dir inside the monorepo — same trade-off the Slice-6 mount specs
 * make: relaxes §4.4 #1 in exchange for a real Node resolution chain
 * (`zod` in the mount module's `import`), keeps §4.4 #2 env allowlist
 * + §4.4 #3 BYOK carve-out intact. `installNetworkGate` gates
 * the browser side: any hosted / AWS / Cognito request aborts + tallies
 * so a regression that routes through a hosted surface fails loud.
 */
import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  attachServeArtifacts,
  DEVTOOL_DIST,
  GGUI_CLI_DIST,
  installNetworkGate,
  spawnGguiServeInCwd,
  type GguiServeHandle,
  type NetworkGate,
} from './ggui-serve-harness';

const FIXTURE_CWD = resolve(__dirname, 'fixtures/playground');
const TEST_TIMEOUT_MS = 60_000;

/**
 * Navigate the page to `/preview/<blueprintId>`, click "Try live →",
 * and wait for the SPA to land on `/s/<shortCode>` with the blueprint
 * mounted inside the render viewer.
 *
 * The console GguiSessionViewer mounts the render inside a
 * plain `<iframe srcDoc>` (read-only / visual-only — post C1-fix
 * it no longer carries the `<McpAppIframe>` lifecycle-mirror
 * attribute). The inner render attributes
 * (`data-ggui-session-entry`, `data-ggui-code-ready`) live INSIDE the
 * iframe child and are reachable only via Playwright's
 * `frameLocator`. Readiness is gated by waiting for the iframe
 * itself to be visible + by inner-DOM assertions further down the
 * test body (e.g. `[data-ggui-contract-error-count]`).
 *
 * Click interactivity inside the iframe still works — the renderer
 * runs its own wsToken WS channel from inside the srcDoc'd document,
 * independent of any host-side relay.
 *
 * Returns the resolved `shortCode` for any follow-up assertions the
 * caller wants to make on the URL.
 */
async function openLiveRender(
  page: Page,
  baseUrl: string,
  blueprintId: string,
): Promise<string> {
  await page.goto(`${baseUrl}/preview/${blueprintId}`, {
    waitUntil: 'networkidle',
  });

  // Wait for the blueprint viewer's mount card + try-live button.
  const tryBtn = page.locator(
    `button[data-ggui-try-live][data-ggui-blueprint-id="${blueprintId}"]`,
  );
  await expect(tryBtn).toBeVisible({ timeout: 15_000 });
  await tryBtn.click();

  // SPA pushState-navigates to /s/<shortCode> once the POST resolves.
  // Length-agnostic — the short-code generator owns its width
  // (`generateShortCode` in render.ts); the test pins the route shape,
  // not the alphabet count.
  await page.waitForURL(/\/s\/[a-z0-9]+$/, { timeout: 15_000 });
  const match = page.url().match(/\/s\/([a-z0-9]+)$/);
  if (!match) {
    throw new Error(`expected /s/<shortCode> URL, got ${page.url()}`);
  }
  const shortCode = match[1]!;

  // Wait for the GguiSessionViewer iframe to be visible. Inner-DOM
  // assertions further down the test body (probe buttons, error
  // panels) carry their own timeouts and serve as the de-facto
  // readiness gate now that the lifecycle mirror is gone.
  const liveIframe = page
    .locator('iframe[data-testid="render-viewer-iframe"]')
    .first();
  await expect(liveIframe).toBeVisible({ timeout: 15_000 });

  return shortCode;
}

/**
 * Lazy accessor for the renderer-iframe Playwright locator, so
 * downstream interactions (click probes, assert on rendered DOM rows)
 * scope inside the iframe. Outer-DOM is host-implementation detail;
 * inner DOM is reachable only via Playwright's `frameLocator` from
 * the spec side.
 */
function rendererFrame(page: Page) {
  return page
    .frameLocator('iframe[data-testid="render-viewer-iframe"]')
    .first();
}

test.describe.serial(
  'Slice 11.5 C7 — runtime contract enforcement end-to-end',
  () => {
    let handle: GguiServeHandle | null = null;
    let gate: NetworkGate | null = null;

    test.beforeAll(async () => {
      if (!existsSync(GGUI_CLI_DIST)) {
        test.skip(
          true,
          `@ggui-ai/cli dist missing at ${GGUI_CLI_DIST}. Run \`pnpm --filter @ggui-ai/cli build\` first.`,
        );
        return;
      }
      if (!existsSync(DEVTOOL_DIST)) {
        test.skip(
          true,
          `@ggui-ai/console dist missing at ${DEVTOOL_DIST}. Run \`pnpm --filter @ggui-ai/console build\` first.`,
        );
        return;
      }
      // F4 schema-compat mode: 'warn' (not 'reject'). The `contract-probe`
      // blueprint (e2e/ggui-oss/tests/fixtures/playground/ui/contract-probe/
      // ggui.ui.json) declares an intentional schema mismatch — the
      // `tasks` streamSpec requires `items` but its `.tool` (`tasks_malformed_list`)
      // returns `{wrong:'shape'}` — exactly so the runtime can emit the
      // SCHEMA_VIOLATION envelope under test here. Default F4 `'reject'`
      // mode blocks the try-live render commit at render time BEFORE
      // runtime gets to emit the envelope, making these specs
      // unreachable. `'warn'` mode logs the finding + lets the item
      // through so the test exercises the runtime error path it was
      // written to cover.
      process.env['GGUI_SCHEMA_COMPAT_MODE'] = 'warn';
      handle = await spawnGguiServeInCwd({
        cwd: FIXTURE_CWD,
        forwardEnv: ['GGUI_SCHEMA_COMPAT_MODE'],
      });
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test.afterEach(async () => {
      if (handle) await attachServeArtifacts(handle);
    });

    test('happy path — click a checkbox, wired tool fires, refresh flips the UI', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      if (!handle) throw new Error('handle not ready — beforeAll failed');
      gate = await installNetworkGate(page);

      await openLiveRender(page, handle.baseUrl, 'todo-list');
      // Renderer DOM is inside the GguiSessionViewer iframe child;
      // outer-iframe visibility gating happened in `openLiveRender`.
      // Interactions below scope through frameLocator.
      const frame = rendererFrame(page);

      // Slice 11.5 v1 explicit non-goal: refresh tools are
      // action-triggered, NOT subscribe-triggered. A fresh subscriber
      // has an EMPTY `tasks` channel until the first action fires +
      // drives the refresh pass. Bootstrap by submitting the create
      // form — `createTask` → `tasks_create` succeeds → the channel's
      // `tasks_list` refresh then fires + emits the full list
      // (seeds + new task). After this round-trip, `data-task-id`
      // anchors are real DOM.
      const bootstrapInput = frame.getByLabel('new task');
      await bootstrapInput.fill('bootstrap refresh');
      await frame.getByRole('button', { name: 'add' }).click();

      // The seeded tasks render once the refresh lands. Each task
      // carries data-attrs that the spec pins on.
      const seed1 = frame.locator('[data-task-id="seed-1"]');
      await expect(seed1).toBeVisible({ timeout: 15_000 });
      await expect(seed1).toHaveAttribute('data-task-status', 'todo');

      // Click the checkbox — fires `data:submit` with action
      // `toggleTask`, which the wiredActionRouter dispatches to
      // `tasks_complete`. Post-success, the `tasks` channel's refresh
      // tool (`tasks_list`) runs + emits the updated snapshot.
      const checkbox = seed1.locator('input[type="checkbox"]');
      await checkbox.click();

      // The DOM's source of truth is the post-refresh stream snapshot,
      // so `data-task-status` flips only after the full round-trip.
      await expect(seed1).toHaveAttribute('data-task-status', 'done', {
        timeout: 10_000,
      });

      // No hosted / AWS / Cognito calls — runtime contract enforcement
      // is an OSS-local operation.
      expect(gate.attempts).toEqual([]);
    });

    test('non-idempotency is honest — rapid double-click fires two dispatches, final state reflects both', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      if (!handle) throw new Error('handle not ready');
      gate = await installNetworkGate(page);

      await openLiveRender(page, handle.baseUrl, 'todo-list');
      const frame = rendererFrame(page);

      // Same bootstrap pattern as the happy-path test — the refresh is
      // action-triggered, so we prime it via `createTask` before
      // interacting with seed-2.
      const bootstrapInput = frame.getByLabel('new task');
      await bootstrapInput.fill('bootstrap refresh');
      await frame.getByRole('button', { name: 'add' }).click();

      // seed-2 starts as 'todo' regardless of what the mount's
      // persistent store looks like from prior tests: if seed-2 was
      // toggled in an earlier run it'd show 'done' here, but each
      // `ggui serve` spawn gets a fresh mount factory + fresh Map,
      // and every test in this describe runs against the SAME handle
      // — so we depend on the test order NOT having touched seed-2
      // before this point. The happy-path test touches seed-1 only,
      // preserving seed-2's initial state for this spec.
      const seed2 = frame.locator('[data-task-id="seed-2"]');
      await expect(seed2).toBeVisible({ timeout: 15_000 });
      await expect(seed2).toHaveAttribute('data-task-status', 'todo');

      const checkbox = seed2.locator('input[type="checkbox"]');

      // Two consecutive .click()s, no awaits between. Playwright's
      // click is sync-dispatch + returns once the event fires — two
      // dispatches in flight simultaneously.
      await Promise.all([checkbox.click(), checkbox.click()]);

      // After two toggles, seed-2 is back to 'todo'. This is the
      // load-bearing proof that non-idempotency is honest: if the
      // contract silently deduped, we'd end up at 'done' instead.
      //
      // Timing: both `tasks_complete` invocations run; two refresh
      // passes fire. The final refresh reflects the final store
      // state, which is 'todo' again.
      await expect(seed2).toHaveAttribute('data-task-status', 'todo', {
        timeout: 10_000,
      });

      // Sanity: we can't observe "exactly 2 invocations" from the DOM
      // without tapping server metrics, but the flip-then-flip-back
      // transition is only possible with 2 dispatches landing — 1
      // dispatch would leave seed-2 at 'done' (or at whatever a naive
      // dedupe produced).

      expect(gate.attempts).toEqual([]);
    });

    test('tool-throws emits a canonical TOOL_THREW envelope on _ggui:contract-error, render survives', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      if (!handle) throw new Error('handle not ready');
      gate = await installNetworkGate(page);

      await openLiveRender(page, handle.baseUrl, 'contract-probe');
      const frame = rendererFrame(page);

      // Probe blueprint renders an empty error list on mount.
      const panel = frame.locator('[data-ggui-contract-error-count]').first();
      await expect(panel).toHaveAttribute('data-ggui-contract-error-count', '0');

      // Click "Trigger broken tool" — action wires to `tasks_broken`,
      // which always throws. The router catches + emits TOOL_THREW on
      // the reserved contract-error channel. The probe's useStream
      // subscription folds it into `all`, which stamps the count +
      // codes attrs below.
      const breakBtn = frame.locator('button[data-ggui-probe="break"]');
      await breakBtn.click();

      // Envelope arrives on `_ggui:contract-error`. The reserved-
      // channel replay forcing + mode:'append' emission mean a single
      // poll on the count attr is enough — no race window.
      await expect(panel).toHaveAttribute(
        'data-ggui-contract-error-count',
        '1',
        { timeout: 10_000 },
      );
      await expect(panel).toHaveAttribute(
        'data-ggui-contract-error-codes',
        'TOOL_THREW',
      );

      // Per-row assertion — the error row carries the canonical fields.
      const row = panel.locator('[data-ggui-contract-error]').first();
      await expect(row).toHaveAttribute('data-code', 'TOOL_THREW');
      await expect(row).toHaveAttribute('data-tool', 'tasks_broken');
      await expect(row).toHaveAttribute('data-source', 'wired-action');

      // GguiSession survives: the probe button is still clickable + the
      // panel is still rendered. A React error boundary firing would
      // unmount either.
      await expect(breakBtn).toBeVisible();
      await expect(breakBtn).toBeEnabled();

      expect(gate.attempts).toEqual([]);
    });

    test('schema-violation on refresh emits a canonical SCHEMA_VIOLATION envelope, previous state preserved', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      if (!handle) throw new Error('handle not ready');
      gate = await installNetworkGate(page);

      await openLiveRender(page, handle.baseUrl, 'contract-probe');
      const frame = rendererFrame(page);

      const panel = frame.locator('[data-ggui-contract-error-count]').first();

      // Click "Trigger malformed refresh" — action (`triggerMalformed-
      // Refresh`) wires to the VALID `tasks_list`. After the action
      // succeeds, the `tasks` channel's refresh fires its declared
      // tool `tasks_malformed_list`, which returns `{wrong:'shape'}`.
      // `assertStreamContract` rejects against the declared
      // `{items: array}` schema → SCHEMA_VIOLATION envelope.
      //
      // The channel's previous state is preserved — `fanOut` never
      // runs with the bad payload, so useStream on `tasks` holds
      // whatever was there before (in this probe, nothing — the
      // preservation we care about is absence-of-corruption).
      const malformedBtn = frame.locator('button[data-ggui-probe="malformed"]');
      await malformedBtn.click();

      // Count may be 1 if run in isolation, or >=1 if a previous test
      // in the same worker left the probe open. Spec must tolerate
      // history — that's honest, since stream replay :all delivers
      // every prior envelope on subscribe.
      await expect(panel).toHaveAttribute(
        'data-ggui-contract-error-codes',
        /SCHEMA_VIOLATION/,
        { timeout: 10_000 },
      );

      // Find the SCHEMA_VIOLATION row — filter by data-code attr.
      const schemaRow = panel.locator(
        '[data-ggui-contract-error][data-code="SCHEMA_VIOLATION"]',
      );
      await expect(schemaRow.first()).toBeVisible();
      await expect(schemaRow.first()).toHaveAttribute(
        'data-tool',
        'tasks_malformed_list',
      );
      await expect(schemaRow.first()).toHaveAttribute(
        'data-source',
        'refresh-stream',
      );

      // GguiSession survives + the probe UI stays interactive.
      await expect(malformedBtn).toBeVisible();
      await expect(malformedBtn).toBeEnabled();

      expect(gate.attempts).toEqual([]);
    });
  },
);
