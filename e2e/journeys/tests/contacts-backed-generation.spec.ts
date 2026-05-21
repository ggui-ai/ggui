/**
 * Lane 2 C1 — Contacts-backed OSS generation + browser render.
 *
 * Closes the second half of the N1 + C1 Lane 2 gap surfaced by the
 * taxonomy-lock doc at `e2e/ggui-oss/LANES.md` (2026-04-24). Pairs
 * with:
 *
 *   - `contacts-mount-via-serve.spec.ts` — Lane 1 mount-through-real-
 *     CLI proof (no LLM, blocking).
 *   - `notes-backed-generation.spec.ts` — sibling N1 Lane 2 spec.
 *   - `tasks-contacts-backed-generation.spec.ts` — P1 composition.
 *
 * This spec closes the diagonal for Contacts: **Contacts mounted via
 * `ggui.json#mcpMounts` + real LLM + real browser render**, proving
 * the strategy doc §4.2 "C1" blocking Lane 2 scenario.
 *
 * Boot path is identical to the sibling Notes spec — real `ggui
 * serve` CLI binary against `fixtures/contacts-mount-via-serve/`. The
 * mount fixture is reused verbatim from the Lane 1 spec.
 *
 * ## Stateful assertions, layered from cheap to deepest
 *
 *   1. **Seed reflected through the mounted MCP wire** — `contacts_list`
 *      returns the 2 seeded rows (Alice + Bob).
 *   2. **Mutation via the mounted MCP wire** — `contacts_create` adds
 *      a row; next `contacts_list` sees it.
 *   3. **Generation over Contacts-backed state renders in the browser**
 *      — `ggui_push` with `story.context.contacts` = full current list
 *      + `story.intent` referencing a seeded displayName → generator
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
 * Per `LANES.md`, strategy doc §4.2 locks C1 into the blocking Lane 2
 * subset (T1 + N1 + C1 + P1). Flipping this spec from advisory to
 * blocking is a CI config change, not a test-shape change.
 *
 * ## Lane classification
 *
 *   **Lane 2** (OSS-live-gen E2E) — advisory today per env gating;
 *   part of the blocking-four set per strategy doc §4.2.
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

const FIXTURE_CWD = resolve(__dirname, 'fixtures/contacts-mount-via-serve');

/** Generous — real Anthropic call + browser boot + layered assertions. */
const TEST_TIMEOUT_MS = 180_000;

/** Push-wait budget — the RPC blocks on real generation. */
const GENERATION_BUDGET_MS = 120_000;

/** Must match `contacts-mount.mjs` seed exactly — copied as literals (spec can't import ESM fixtures). */
const SEEDED_NAMES = ['Alice Chen', 'Bob Patel'];
const SEEDED_COUNT = 2;
const SEEDED_NAME_FIRST = 'Alice Chen';

const MUTATION_NAME = 'Carla Rivera';
const MUTATION_EMAIL = 'carla@example.com';

test.describe.serial(
  'Lane 2 C1 — Contacts-backed OSS generation + browser render (advisory)',
  () => {
    let handle: GguiServeHandle | null = null;
    let skipped = false;

    test.beforeAll(async () => {
      const skip = shouldSkipLane2Advisory({
        specLabel: 'Lane 2 C1 Contacts proof',
      });
      if (skip.skip) {
        skipped = true;
        test.skip(true, skip.reason);
        return;
      }

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

    test('Contacts-mounted OSS server: seed reflected → mutation visible → generation renders', async ({
      page,
    }) => {
      if (skipped || !handle) return;
      test.setTimeout(TEST_TIMEOUT_MS);

      const baseUrl = handle.baseUrl;
      const { token } = await mintPairToken(handle, 'contacts-backed-generation');
      expect(token.length).toBeGreaterThan(0);

      // ─────────────────────────────────────────────────────────
      // Claim 1: seed reflected through the mounted /mcp wire.
      // ─────────────────────────────────────────────────────────
      const list1 = await mcpCallAs(baseUrl, token, 'tools/call', {
        name: 'contacts_list',
        arguments: {},
      });
      expect(list1.error).toBeUndefined();
      const list1Result = list1.result as {
        structuredContent?: { items?: Array<{ id: string; displayName: string }> };
        isError?: boolean;
      };
      expect(list1Result.isError).not.toBe(true);
      const seededItems = list1Result.structuredContent?.items ?? [];
      expect(
        seededItems.length,
        `contacts_list returned ${seededItems.length} items — expected ${SEEDED_COUNT} seeded rows.`,
      ).toBe(SEEDED_COUNT);
      expect(seededItems.map((i) => i.displayName).sort()).toEqual([...SEEDED_NAMES].sort());

      // ─────────────────────────────────────────────────────────
      // Claim 2: mutation via the mounted MCP wire + next read sees it.
      // ─────────────────────────────────────────────────────────
      const createRes = await mcpCallAs(baseUrl, token, 'tools/call', {
        name: 'contacts_create',
        arguments: { input: { displayName: MUTATION_NAME, email: MUTATION_EMAIL } },
      });
      expect(createRes.error).toBeUndefined();
      const createResult = createRes.result as {
        structuredContent?: { item?: { id: string; displayName: string; email: string | null } };
        isError?: boolean;
      };
      expect(createResult.isError).not.toBe(true);
      const createdId = createResult.structuredContent?.item?.id;
      expect(createdId, 'contacts_create returned no item.id').toBeTruthy();
      expect(createResult.structuredContent?.item?.displayName).toBe(MUTATION_NAME);
      expect(createResult.structuredContent?.item?.email).toBe(MUTATION_EMAIL);

      const list2 = await mcpCallAs(baseUrl, token, 'tools/call', {
        name: 'contacts_list',
        arguments: {},
      });
      const list2Result = list2.result as {
        structuredContent?: { items?: Array<{ id: string; displayName: string }> };
      };
      const postItems = list2Result.structuredContent?.items ?? [];
      expect(postItems.length).toBe(SEEDED_COUNT + 1);
      expect(
        postItems.some((i) => i.id === createdId && i.displayName === MUTATION_NAME),
        `contacts_list post-create did not contain { id: ${createdId}, displayName: "${MUTATION_NAME}" }.`,
      ).toBe(true);

      // ─────────────────────────────────────────────────────────
      // Claim 3: generation over Contacts-backed state renders in
      // the browser. Anchor intent on a seeded displayName so the
      // generator has a real reference to fold into its output. DOM
      // assertions stay shape-only per CLAUDE.md.
      // ─────────────────────────────────────────────────────────
      const intent = [
        `Render a simple contact card or list showing the user's contacts.`,
        `Emphasize "${SEEDED_NAME_FIRST}" — they are the primary contact.`,
        `Use only basic HTML elements; no external assets.`,
      ].join(' ');

      // Post-Slice-5 push is handshake-first: new_session → handshake →
      // push({handshakeId, decision}). Direct story-shaped push is
      // retired; the legacy `story.context` carrier for backing state
      // is no longer on the wire (the generator picks up Contacts via
      // mounted tools the LLM can call, not via inlined fixtures).
      const sessEnv = await mcpCallAs(baseUrl, token, 'tools/call', {
        name: 'ggui_new_session',
        arguments: {},
      });
      const sessionId = (
        sessEnv.result as { structuredContent: { sessionId: string } }
      ).structuredContent.sessionId;
      const hsEnv = await mcpCallAs(baseUrl, token, 'tools/call', {
        name: 'ggui_handshake',
        arguments: {
          sessionId,
          intent,
          blueprintDraft: { contract: {} },
          // Bypass the built-in blueprint matcher so the push runs real
          // generation — see live-generation.spec.ts for the rationale.
          forceCreate: true,
        },
      });
      const handshakeId = (
        hsEnv.result as { structuredContent: { handshakeId: string } }
      ).structuredContent.handshakeId;

      const pushStart = Date.now();
      const pushEnv = await Promise.race<ReturnType<typeof mcpCallAs>>([
        mcpCallAs(baseUrl, token, 'tools/call', {
          name: 'ggui_push',
          arguments: { handshakeId, decision: { kind: 'override', blueprintDraft: { contract: {} } } },
        }),
        new Promise((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `ggui_push did not return within ${GENERATION_BUDGET_MS}ms. stderr:\n${handle?.stderr() ?? ''}`,
                ),
              ),
            GENERATION_BUDGET_MS,
          ),
        ) as Promise<never>,
      ]);
      const pushElapsedMs = Date.now() - pushStart;

      expect(pushEnv.error).toBeUndefined();
      // Post-Slice-5 structuredContent: {stackItemId, url, action,
      // nextStep?}. shortCode is the tail of url; codeReady retired
      // (the visual stack-item assertions below are the structural
      // proof generation succeeded).
      const pushResult = pushEnv.result as {
        structuredContent?: { stackItemId?: string; url?: string };
        isError?: boolean;
      };
      expect(
        pushResult.isError,
        `ggui_push returned isError: true — check CLI stderr for generator failure.`,
      ).not.toBe(true);
      expect(pushResult.structuredContent?.stackItemId).toBeTruthy();
      const pushUrl = pushResult.structuredContent?.url;
      expect(pushUrl, 'ggui_push returned no url').toBeTruthy();
      const shortCodeMatch = new URL(pushUrl!).pathname.match(/^\/[rs]\/([^/?]+)/);
      expect(shortCodeMatch, `push url is not /r/<shortCode>: ${pushUrl}`).not.toBeNull();
      const shortCode = shortCodeMatch![1]!;
      expect(
        pushElapsedMs,
        `ggui_push returned in ${pushElapsedMs}ms — too fast for a real LLM call.`,
      ).toBeGreaterThan(1_000);

      await page.goto(`${baseUrl}/s/${shortCode}`, { waitUntil: 'networkidle' });

      // Post-C9.5 the live SessionViewer wraps the rendered stack in
      // `<McpAppIframe>`; inner componentCard data-attrs live INSIDE
      // the iframe. Pin on the protocol-defined outer-DOM ready signal
      // (`McpAppLifecycleMessage` → `code-ready`) before reaching into
      // inner DOM via `frameLocator`. Mirrors
      // `runtime-contract.spec.ts::openLiveSession`.
      const liveIframe = page
        .locator('iframe[data-ggui-mcp-app-iframe]')
        .first();
      await expect(liveIframe).toHaveAttribute(
        'data-ggui-mcp-app-iframe-lifecycle',
        'code-ready',
        { timeout: 15_000 },
      );

      // The renderer mounts each stack item into a
      // `<div data-ggui-stack-item-root="<id>">` (see
      // `iframe-runtime/src/runtime.ts::containerFor`). Inside that,
      // the React mount wraps the tree in a `ggui-rcr-*` scope div.
      const frame = page.frameLocator('iframe[data-ggui-mcp-app-iframe]').first();
      const stackItemRoot = frame.locator('[data-ggui-stack-item-root]');
      await expect(stackItemRoot).toBeVisible({ timeout: 30_000 });

      const rcrScope = stackItemRoot.locator('[class^="ggui-rcr-"]');
      await expect(rcrScope).toBeVisible({ timeout: 30_000 });
      const scopeChildren = await rcrScope.evaluate((el) => el.children.length);
      expect(
        scopeChildren,
        `ggui-rcr-* scope has ${scopeChildren} children — expected ≥ 1 (real componentCode must render SOME DOM).`,
      ).toBeGreaterThanOrEqual(1);
    });
  },
);
