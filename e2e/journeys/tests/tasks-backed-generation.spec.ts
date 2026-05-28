/**
 * OSS Slice 6 payoff: the first Tasks-backed end-to-end product proof.
 *
 * Pairs with:
 *   - `live-generation.spec.ts` — "real LLM + browser" half, no Tasks.
 *   - `packages/mcp-server/src/mcp-mounts.test.ts`
 *     + `fixtures/mcps/tasks/mount-integration.test.ts` — "mount seam
 *     wires correctly" half, no LLM, no browser.
 *
 * This spec closes the diagonal: **Tasks mounted + real LLM + real
 * browser render** over the Slice 6 `mcpMounts` seam, proving the
 * runtime wiring actually delivers product value — generation over
 * live Tasks-backed local state rendering in a real browser.
 *
 * ## Boot path — dedicated child-process launcher
 *
 * Sibling OSS specs spawn `ggui serve` via {@link spawnGguiServe}.
 * `ggui serve` has no `mcpMounts` surface today (by design —
 * `ggui.json#mcpMounts` is a dedicated follow-up slice). This spec
 * uses {@link spawnTasksBackedServe}, which boots
 * `./tasks-backed-launcher.ts` in a subprocess. That launcher calls
 * `createGguiServer({ ..., mcpMounts: [tasks] })` directly — the
 * same factory `ggui serve` calls internally — with the Tasks
 * mount passed in. The boot-beacon contract (`READY <url>\n` +
 * `PAIR_CODE <code>\n`) matches the CLI's so every harness helper
 * (`mintPairToken`, `mcpCallAs`, `attachServeArtifacts`) is reusable.
 *
 * Why subprocess, not in-process compose: `@ggui-ai/mcp-server` +
 * `@ggui-ai/ui-gen` are ESM-only, and Playwright 1.58 loads specs
 * through a CJS TS pipeline — a direct `import` from the spec fails
 * with "No exports main defined". The launcher is ESM (via `tsx`)
 * and owns the `createGguiServer` compose; the spec talks to it
 * over HTTP, which is also what a real MCP client would do.
 *
 * ## Stateful assertions, layered from cheap to deepest
 *
 * 1. **Seed reflected through the mounted MCP wire** — `tasks_list`
 *    returns the 3 deterministically-seeded rows (proves the
 *    mounted wire reads from the store the launcher seeded; the
 *    mount is live, not the default empty state).
 * 2. **Mutation via the mounted MCP wire** — `tasks_create` returns
 *    the new item with the expected title + default status (proves
 *    the mount's `handler` dispatches writes, not shadow-read-only).
 * 3. **Mutation visible on subsequent MCP read** — `tasks_list`
 *    reflects the new row (proves the write was durable across
 *    dispatch — the store is the single source of truth).
 * 4. **Generation over Tasks-backed state renders in the browser** —
 *    `ggui_render` with `story.context.tasks` = full current list +
 *    `story.intent` referencing a seeded title → generator produces
 *    componentCode → console viewer mounts the compiled
 *    component with a `ggui-rcr-*` scope + rendered DOM (shape-only
 *    assertions per CLAUDE.md "Testing LLM-Generated UI" — LLM
 *    output is non-deterministic).
 *
 * Four layered stateful claims on one spec. If any flips, we know
 * exactly which tier of the Tasks-backed runtime broke.
 *
 * ## Gating (advisory lane — NOT blocking)
 *
 *   - Skips when `ANTHROPIC_API_KEY` is unset / empty.
 *   - Skips when `GGUI_OSS_LIVE_BYOK=0` (operator opt-out).
 *   - Skips when `@ggui-ai/console` dist is missing.
 *
 * ## Not in this spec
 *
 *   - Notes / Contacts fixtures (Slice 6.2 / 6.3; out of scope).
 *   - Multi-MCP composition (Slice 6.4+; out of scope).
 *   - `ggui_handshake` on OSS (Slice 5; out of scope).
 *   - Runtime blueprint registration API (Slice P1; out of scope).
 *   - ChatShell 8b (out of scope).
 *   - `ggui.json#mcpMounts` CLI config loader (dedicated follow-up).
 *   - Direct sqlite-store read from the spec — the launcher owns the
 *     store. Claim #3 covers the same truth via the MCP wire
 *     round-trip.
 */
import { test, expect } from '@playwright/test';
import {
  attachServeArtifacts,
  mcpCallAs,
  mintPairToken,
  shouldSkipLane2Advisory,
  spawnTasksBackedServe,
  type GguiServeHandle,
} from './ggui-serve-harness';

/** Generous — real Anthropic call + browser boot + layered assertions. */
const TEST_TIMEOUT_MS = 180_000;

/** Push-wait budget — the RPC blocks on real generation. */
const GENERATION_BUDGET_MS = 120_000;

const MUTATION_TITLE = 'Ship Slice 6 Tasks-backed product proof';

/**
 * Deterministic reference to the canonical seed. Must match
 * `fixtures/mcps/tasks/seed.ts::TASKS_SEED[0].title` — the launcher
 * seeds from that exact constant, so if the fixture's first title
 * changes this spec's intent-reference will miss. Copied as a string
 * literal (not imported) because the spec can't pull ESM-only fixture
 * modules — see boot-path notes in the JSDoc above.
 */
const SEEDED_TITLE_FIRST = 'Ship Phase 5 OSS launch';
const SEEDED_COUNT = 5;

test.describe.serial(
  'Slice 6 — Tasks-backed OSS generation + browser render (advisory)',
  () => {
    let handle: GguiServeHandle | null = null;
    let skipped = false;

    test.beforeAll(async () => {
      const skip = shouldSkipLane2Advisory({
        specLabel: 'tasks-backed product proof',
      });
      if (skip.skip) {
        skipped = true;
        test.skip(true, skip.reason);
        return;
      }

      handle = await spawnTasksBackedServe({
        forwardEnv: ['ANTHROPIC_API_KEY'],
      });
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test.afterEach(async () => {
      if (handle) await attachServeArtifacts(handle);
    });

    test('Tasks-mounted OSS server: seed reflected → mutation visible → generation renders', async ({
      page,
    }) => {
      if (skipped || !handle) return;
      test.setTimeout(TEST_TIMEOUT_MS);

      const baseUrl = handle.baseUrl;

      // Strict-auth pairing flow — same as live-generation.spec.
      const { token } = await mintPairToken(
        handle,
        'tasks-backed-generation',
      );
      expect(token.length).toBeGreaterThan(0);

      // ─────────────────────────────────────────────────────────
      // Claim 1: seed reflected through the mounted /mcp wire.
      // ─────────────────────────────────────────────────────────
      const list1 = await mcpCallAs(baseUrl, token, 'tools/call', {
        name: 'tasks_list',
        arguments: {},
      });
      expect(list1.error).toBeUndefined();
      const list1Result = list1.result as {
        structuredContent?: { items?: Array<{ id: string; title: string }> };
        isError?: boolean;
      };
      expect(list1Result.isError).not.toBe(true);
      const seededItems = list1Result.structuredContent?.items ?? [];
      expect(
        seededItems.length,
        `tasks_list returned ${seededItems.length} items — expected ${SEEDED_COUNT} seeded rows from the canonical fixture seed through the mounted MCP wire.`,
      ).toBe(SEEDED_COUNT);
      expect(seededItems.map((i) => i.title)).toContain(SEEDED_TITLE_FIRST);

      // ─────────────────────────────────────────────────────────
      // Claim 2: mutation via the mounted MCP wire.
      // ─────────────────────────────────────────────────────────
      const createRes = await mcpCallAs(baseUrl, token, 'tools/call', {
        name: 'tasks_create',
        arguments: { input: { title: MUTATION_TITLE } },
      });
      expect(createRes.error).toBeUndefined();
      const createResult = createRes.result as {
        structuredContent?: {
          item?: { id: string; title: string; status: string };
        };
        isError?: boolean;
      };
      expect(createResult.isError).not.toBe(true);
      const createdId = createResult.structuredContent?.item?.id;
      expect(createdId, 'tasks_create returned no item.id').toBeTruthy();
      expect(createResult.structuredContent?.item?.title).toBe(MUTATION_TITLE);
      expect(createResult.structuredContent?.item?.status).toBe('todo');

      // ─────────────────────────────────────────────────────────
      // Claim 3: subsequent MCP read reflects the mutation.
      // ─────────────────────────────────────────────────────────
      const list2 = await mcpCallAs(baseUrl, token, 'tools/call', {
        name: 'tasks_list',
        arguments: {},
      });
      const list2Result = list2.result as {
        structuredContent?: { items?: Array<{ id: string; title: string }> };
      };
      const postItems = list2Result.structuredContent?.items ?? [];
      expect(postItems.length).toBe(SEEDED_COUNT + 1);
      expect(
        postItems.some(
          (i) => i.id === createdId && i.title === MUTATION_TITLE,
        ),
        `tasks_list post-create did not contain { id: ${createdId}, title: "${MUTATION_TITLE}" }. The mutation from claim #2 did not land in the store.`,
      ).toBe(true);

      // ─────────────────────────────────────────────────────────
      // Claim 4: generation over real Tasks-backed state renders in
      //  the browser.
      //
      //  `story.context.tasks` carries the current list verbatim.
      //  `push.ts` forwards it (`isJsonObject(story.context)` →
      //  generator's `request.context`), and `buildUserPrompt` JSON-
      //  injects it into the LLM prompt. Anchoring intent on a seeded
      //  title nudges the generator toward a deterministic reference
      //  — the BROWSER assertions stay shape-only because LLM output
      //  is non-deterministic (per CLAUDE.md).
      // ─────────────────────────────────────────────────────────
      const intent = [
        `Render a simple card or list showing the user's open tasks.`,
        `Highlight the task titled "${SEEDED_TITLE_FIRST}" — it is the top priority.`,
        `Use only basic HTML elements; no external assets.`,
      ].join(' ');

      // Post-Phase-B render is handshake-first: handshake → render
      // ({handshakeId, decision}). The prior `ggui_new_session` mint
      // is gone — every render IS the addressable scope. Direct story-
      // shaped render is retired; the legacy `story.context` carrier
      // for backing state is no longer on the wire (the generator
      // picks up Tasks via mounted tools the LLM can call, not via
      // inlined fixtures).
      const hsEnv = await mcpCallAs(baseUrl, token, 'tools/call', {
        name: 'ggui_handshake',
        arguments: {
          intent,
          blueprintDraft: { contract: {} },
        },
      });
      const handshakeId = (
        hsEnv.result as { structuredContent: { handshakeId: string } }
      ).structuredContent.handshakeId;

      const renderStart = Date.now();
      const renderEnv = await Promise.race<ReturnType<typeof mcpCallAs>>([
        mcpCallAs(baseUrl, token, 'tools/call', {
          name: 'ggui_render',
          arguments: { handshakeId, decision: { kind: 'override', blueprintDraft: { contract: {} } } },
        }),
        new Promise((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `ggui_render did not return within ${GENERATION_BUDGET_MS}ms. stderr:\n${handle?.stderr() ?? ''}`,
                ),
              ),
            GENERATION_BUDGET_MS,
          ),
        ) as Promise<never>,
      ]);
      const renderElapsedMs = Date.now() - renderStart;

      expect(renderEnv.error).toBeUndefined();
      // Post-Phase-B structuredContent: {renderId, url, action,
      // nextStep?}. shortCode is the tail of url; codeReady retired
      // (the render assertions below are the structural proof
      // generation succeeded).
      const renderResult = renderEnv.result as {
        structuredContent?: { renderId?: string; url?: string };
        isError?: boolean;
      };
      expect(
        renderResult.isError,
        `ggui_render returned isError: true — check launcher stderr for generator failure.`,
      ).not.toBe(true);
      expect(renderResult.structuredContent?.renderId).toBeTruthy();
      const renderUrl = renderResult.structuredContent?.url;
      expect(renderUrl, 'ggui_render returned no url').toBeTruthy();
      const shortCodeMatch = new URL(renderUrl!).pathname.match(/^\/[rs]\/([^/?]+)/);
      expect(shortCodeMatch, `render url is not /r/<shortCode>: ${renderUrl}`).not.toBeNull();
      const shortCode = shortCodeMatch![1]!;
      // A real Anthropic call is never sub-second — catches a future
      // regression where generation silently stubs out.
      expect(
        renderElapsedMs,
        `ggui_render returned in ${renderElapsedMs}ms — too fast for a real LLM call.`,
      ).toBeGreaterThan(1_000);

      await page.goto(`${baseUrl}/s/${shortCode}`, {
        waitUntil: 'networkidle',
      });

      // The console RenderViewer mounts the rendered UI inside a
      // plain `<iframe srcDoc>` (read-only / visual-only — post C1-fix
      // it no longer carries the `<McpAppIframe>` lifecycle-mirror
      // attribute). Readiness is gated by the inner `ggui-rcr-*`
      // scope visibility check below — 60s budget covers slow runner
      // cases where the iframe runtime is still fetching the bundle
      // when ggui_render returns. Other Lane-2 specs (cache-reuse,
      // notes-backed) saw similar latency under live LLM and bumped
      // past the original 15s budget; mirror that here.
      const liveIframe = page
        .locator('iframe[data-testid="render-viewer-iframe"]')
        .first();
      await expect(liveIframe).toBeVisible({ timeout: 15_000 });

      // Post-stack-removal (2026-05-27) the iframe-runtime mounts the
      // React tree directly into the iframe body. The React mount
      // wraps its tree in a `ggui-rcr-*` scope div. Presence + ≥1
      // child proves the esbuild-compiled ESM loaded + a real React
      // component mounted (not the loading fallback, not the error
      // boundary).
      const frame = page
        .frameLocator('iframe[data-testid="render-viewer-iframe"]')
        .first();
      const rcrScope = frame.locator('[class^="ggui-rcr-"]');
      await expect(rcrScope).toBeVisible({ timeout: 30_000 });
      const scopeChildren = await rcrScope.evaluate(
        (el) => el.children.length,
      );
      expect(
        scopeChildren,
        `ggui-rcr-* scope has ${scopeChildren} children — expected ≥ 1 (real componentCode must render SOME DOM).`,
      ).toBeGreaterThanOrEqual(1);
    });
  },
);
