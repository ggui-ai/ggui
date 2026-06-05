/**
 * Lane 2 N1 — Notes-backed OSS generation + browser render.
 *
 * Closes the first half of the N1 + C1 Lane 2 gap surfaced by the
 * taxonomy-lock doc at `e2e/ggui-oss/LANES.md` (2026-04-24). Pairs
 * with:
 *
 *   - `notes-mount-via-serve.spec.ts` — Lane 1 mount-through-real-CLI
 *     proof (no LLM, blocking).
 *   - `tasks-backed-generation.spec.ts` — sibling T1 Lane 2 spec.
 *   - `tasks-contacts-backed-generation.spec.ts` — P1 composition.
 *
 * This spec closes the diagonal for Notes: **Notes mounted via
 * `ggui.json#mcpMounts` + real LLM + real browser render**, proving
 * the strategy doc §4.2 "N1" blocking Lane 2 scenario.
 *
 * Unlike `tasks-backed-generation.spec.ts` — which predates Slice
 * 6.2's `ggui.json#mcpMounts` config path and uses a dedicated
 * `tasks-backed-launcher.ts` subprocess — this spec boots the real
 * `ggui serve` CLI binary against `fixtures/notes-mount-via-serve/`.
 * The mount fixture is reused verbatim from the Lane 1 spec; only
 * the advisory-skip envelope + LLM call + browser render are new.
 *
 * ## Stateful assertions, layered from cheap to deepest
 *
 *   1. **Seed reflected through the mounted MCP wire** — `notes_list`
 *      returns the 2 seeded rows from the mount factory closure.
 *   2. **Mutation via the mounted MCP wire** — `notes_create` adds
 *      a row; next `notes_list` sees it.
 *   3. **Generation over Notes-backed state renders in the browser**
 *      — `ggui_render` with `story.context.notes` = full current list
 *      + `story.intent` referencing a seeded title → generator
 *      produces componentCode → console viewer mounts it with a
 *      `ggui-rcr-*` scope + rendered DOM (shape-only per CLAUDE.md
 *      "Testing LLM-Generated UI").
 *
 * ## Gating (advisory lane — NOT blocking today)
 *
 *   - Skips when `ANTHROPIC_API_KEY` is unset / empty.
 *   - Skips when `GGUI_OSS_LIVE_BYOK=0` (operator opt-out).
 *   - Skips when `@ggui-ai/console` dist is missing.
 *   - Skips when `@ggui-ai/cli` dist is missing.
 *
 * Per `LANES.md`, the strategy doc §4.2 locks N1 into the blocking
 * Lane 2 subset (T1 + N1 + C1 + P1). Flipping this spec from advisory
 * to blocking is a CI config change, not a test-shape change — the
 * advisory-skip helper here matches the sibling specs' pattern
 * already so a future factor-out + gating flip is a single commit.
 *
 * ## Lane classification
 *
 *   **Lane 2** (OSS-live-gen E2E) — advisory today per env
 *   gating; part of the blocking-four set per strategy doc §4.2.
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import {
  attachServeArtifacts,
  mcpCallAs,
  mintPairToken,
  shouldSkipLane2Advisory,
  spawnGguiServeInCwd,
  type GguiServeHandle,
} from './ggui-serve-harness';

const FIXTURE_CWD = resolve(__dirname, 'fixtures/notes-mount-via-serve');

/** Generous — real Anthropic call + browser boot + layered assertions. */
const TEST_TIMEOUT_MS = 180_000;

/** GguiSession-wait budget — the RPC blocks on real generation. */
const GENERATION_BUDGET_MS = 120_000;

/** Must match the `notes-mount.mjs` seed exactly — copied as literals (spec can't import ESM fixtures). */
const SEEDED_TITLES = ['Slice 6.2 plan', 'Pricing research'];
const SEEDED_COUNT = 2;
const SEEDED_TITLE_FIRST = 'Slice 6.2 plan';

const MUTATION_TITLE = 'Ship Lane 2 N1 Notes generation proof';
const MUTATION_BODY = 'Drafted against ggui.json#mcpMounts mount path.';

test.describe.serial('Lane 2 N1 — Notes-backed OSS generation + browser render (advisory)', () => {
  let handle: GguiServeHandle | null = null;
  let skipped = false;

  test.beforeAll(async () => {
    const skip = shouldSkipLane2Advisory({ specLabel: 'Lane 2 N1 Notes proof' });
    if (skip.skip) {
      skipped = true;
      test.skip(true, skip.reason);
      return;
    }

    // Real CLI binary + real ggui.json#mcpMounts discovery (no
    // dedicated launcher — the mount-via-serve pattern shipped in
    // Slice 6.2 is canonical for Lane 2 now too).
    handle = await spawnGguiServeInCwd({
      cwd: FIXTURE_CWD,
      forwardEnv: ['ANTHROPIC_API_KEY'],
    });
  });

  test.afterAll(async () => {
    if (handle) await handle.close();
  });

  test.afterEach(async () => {
    if (handle) await attachServeArtifacts(handle);
  });

  test('Notes-mounted OSS server: seed reflected → mutation visible → generation renders', async ({
    page,
  }) => {
    if (skipped || !handle) return;
    test.setTimeout(TEST_TIMEOUT_MS);

    const baseUrl = handle.baseUrl;
    const { token } = await mintPairToken(handle, 'notes-backed-generation');
    expect(token.length).toBeGreaterThan(0);

    // ─────────────────────────────────────────────────────────
    // Claim 1: seed reflected through the mounted /mcp wire.
    // ─────────────────────────────────────────────────────────
    const list1 = await mcpCallAs(baseUrl, token, 'tools/call', {
      name: 'notes_list',
      arguments: {},
    });
    expect(list1.error).toBeUndefined();
    const list1Result = list1.result as {
      structuredContent?: { items?: Array<{ id: string; title: string; body: string }> };
      isError?: boolean;
    };
    expect(list1Result.isError).not.toBe(true);
    const seededItems = list1Result.structuredContent?.items ?? [];
    expect(
      seededItems.length,
      `notes_list returned ${seededItems.length} items — expected ${SEEDED_COUNT} seeded rows from the canonical fixture seed.`,
    ).toBe(SEEDED_COUNT);
    expect(seededItems.map((i) => i.title).sort()).toEqual([...SEEDED_TITLES].sort());

    // ─────────────────────────────────────────────────────────
    // Claim 2: mutation via the mounted MCP wire + next read sees it.
    // ─────────────────────────────────────────────────────────
    const createRes = await mcpCallAs(baseUrl, token, 'tools/call', {
      name: 'notes_create',
      arguments: { input: { title: MUTATION_TITLE, body: MUTATION_BODY } },
    });
    expect(createRes.error).toBeUndefined();
    const createResult = createRes.result as {
      structuredContent?: { item?: { id: string; title: string; body: string } };
      isError?: boolean;
    };
    expect(createResult.isError).not.toBe(true);
    const createdId = createResult.structuredContent?.item?.id;
    expect(createdId, 'notes_create returned no item.id').toBeTruthy();
    expect(createResult.structuredContent?.item?.title).toBe(MUTATION_TITLE);
    expect(createResult.structuredContent?.item?.body).toBe(MUTATION_BODY);

    const list2 = await mcpCallAs(baseUrl, token, 'tools/call', {
      name: 'notes_list',
      arguments: {},
    });
    const list2Result = list2.result as {
      structuredContent?: { items?: Array<{ id: string; title: string; body: string }> };
    };
    const postItems = list2Result.structuredContent?.items ?? [];
    expect(postItems.length).toBe(SEEDED_COUNT + 1);
    expect(
      postItems.some((i) => i.id === createdId && i.title === MUTATION_TITLE),
      `notes_list post-create did not contain { id: ${createdId}, title: "${MUTATION_TITLE}" }.`,
    ).toBe(true);

    // ─────────────────────────────────────────────────────────
    // Claim 3: generation over Notes-backed state renders in browser.
    //
    // `story.context.notes` carries the current list verbatim.
    // `render.ts` forwards context into the generator prompt, anchoring
    // on a seeded title nudges the output toward the real data. The
    // BROWSER assertions stay shape-only because LLM output is
    // non-deterministic (CLAUDE.md).
    // ─────────────────────────────────────────────────────────
    const intent = [
      `GguiSession a simple list or card showing the user's notes.`,
      `Highlight the note titled "${SEEDED_TITLE_FIRST}" — it is the current priority.`,
      `Use only basic HTML elements; no external assets.`,
    ].join(' ');

    // Post-Phase-B render is handshake-first: handshake → render
    // ({handshakeId, props, override?}). The prior `ggui_new_session` mint is
    // gone — every render IS the addressable scope. Direct story-
    // shaped render is retired; the legacy `story.context` carrier
    // for backing state is no longer on the wire (the generator picks
    // up Notes via mounted tools the LLM can call, not via inlined
    // fixtures). Intent carries the routing signal entirely.
    const hsEnv = await mcpCallAs(baseUrl, token, 'tools/call', {
      name: 'ggui_handshake',
      arguments: {
        intent,
        blueprintDraft: { contract: {} },
        // Bypass the built-in blueprint matcher so render runs real
        // generation — see live-generation.spec.ts for the rationale.
        forceCreate: true,
      },
    });
    const handshakeId = (
      hsEnv.result as { structuredContent: { handshakeId: string } }
    ).structuredContent.handshakeId;

    const renderStart = Date.now();
    const renderEnv = await Promise.race<ReturnType<typeof mcpCallAs>>([
      mcpCallAs(baseUrl, token, 'tools/call', {
        name: 'ggui_render',
        arguments: { handshakeId, props: {}, override: { contract: {} } },
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
    // Post-Phase-B structuredContent surface: {renderId, url,
    // action, nextStep?}. shortCode is the tail of url's /r/<...> path;
    // codeReady was retired (the visual render assertions below are
    // the structural proof generation succeeded).
    const renderResult = renderEnv.result as {
      structuredContent?: { renderId?: string; url?: string };
      isError?: boolean;
    };
    expect(
      renderResult.isError,
      `ggui_render returned isError: true — check CLI stderr for generator failure.`,
    ).not.toBe(true);
    expect(renderResult.structuredContent?.renderId).toBeTruthy();
    const renderUrl = renderResult.structuredContent?.url;
    expect(renderUrl, 'ggui_render returned no url').toBeTruthy();
    const shortCodeMatch = new URL(renderUrl!).pathname.match(/^\/[rs]\/([^/?]+)/);
    expect(shortCodeMatch, `render url is not /r/<shortCode>: ${renderUrl}`).not.toBeNull();
    const shortCode = shortCodeMatch![1]!;
    expect(
      renderElapsedMs,
      `ggui_render returned in ${renderElapsedMs}ms — too fast for a real LLM call.`,
    ).toBeGreaterThan(1_000);

    await page.goto(`${baseUrl}/s/${shortCode}`, { waitUntil: 'networkidle' });

    // The console GguiSessionViewer mounts the rendered UI inside a plain
    // `<iframe srcDoc>` (read-only / visual-only — post C1-fix it no
    // longer carries the `<McpAppIframe>` lifecycle-mirror attribute).
    // Readiness is gated by the inner `ggui-rcr-*` scope visibility
    // check below — the renderer React-mounts inside the iframe once
    // the bundle has loaded.
    const liveIframe = page
      .locator('iframe[data-testid="render-viewer-iframe"]')
      .first();
    await expect(liveIframe).toBeVisible({ timeout: 15_000 });

    // Post-stack-removal (2026-05-27) the iframe-runtime mounts the
    // React tree directly into the iframe body. The React mount
    // wraps its tree in a `ggui-rcr-*` scope div.
    const frame = page
      .frameLocator('iframe[data-testid="render-viewer-iframe"]')
      .first();
    const rcrScope = frame.locator('[class^="ggui-rcr-"]');
    await expect(rcrScope).toBeVisible({ timeout: 30_000 });
    const scopeChildren = await rcrScope.evaluate((el) => el.children.length);
    expect(
      scopeChildren,
      `ggui-rcr-* scope has ${scopeChildren} children — expected ≥ 1 (real componentCode must render SOME DOM).`,
    ).toBeGreaterThanOrEqual(1);
  });
});
