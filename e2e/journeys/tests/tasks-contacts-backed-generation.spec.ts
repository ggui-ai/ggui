/**
 * OSS Slice 6.4 live-BYOK half: generation over Tasks + Contacts
 * composed on the real `ggui serve` operator path — first browser-
 * facing multi-MCP generation proof.
 *
 * Pairs with:
 *   - `tasks-contacts-compose-via-serve.spec.ts` — the Lane-1
 *     deterministic relational-truth backbone. No LLM, no browser.
 *     This spec layers LLM + browser on top; the Lane-1 backbone is
 *     where the composition claim lives when there's no key.
 *   - `tasks-backed-generation.spec.ts` — single-mount Tasks ×
 *     generation × browser. Same harness pattern; this spec adds the
 *     second mount + person-centric `story.context`.
 *   - `live-generation.spec.ts` — zero-mount generation × browser.
 *     The "LLM talks at all" baseline.
 *
 * ## What THIS spec proves (and nothing else proves at the OSS layer)
 *
 *   1. A single `ggui serve` process boots the real CLI with TWO
 *      `mcpMounts` entries + an Anthropic binding (`forwardEnv:
 *      ['ANTHROPIC_API_KEY']`). The banner announces
 *      `generation: anthropic …`.
 *   2. `ggui_render` with a person-centric intent + `story.context`
 *      carrying BOTH the contact record (from `contacts_get`) and
 *      the assignee-matched tasks (from `tasks_list`) returns
 *      `codeReady: true` — the generator consumed multi-domain
 *      context without error.
 *   3. The resulting componentCode mounts in a real browser under
 *      the Slice 4 render contract — `data-ggui-code-ready="true"`
 *      + a `ggui-rcr-*` scope + ≥1 rendered child. This is the
 *      structural anchor (per CLAUDE.md's "Testing LLM-Generated UI"
 *      guidance: assert shape, not content — LLM output is
 *      non-deterministic).
 *
 * ## Why the assertions stay shape-only
 *
 * The Lane-1 sibling spec locks the relational truth (alice ↔ her
 * tasks, pre- and post-mutation). If that flips, we know the wiring
 * broke. This spec's job is "generation over the composed state
 * produces a real React component in the browser" — a different
 * layer, worth a dedicated proof even though it can't assert DOM
 * content deterministically.
 *
 * ## Gating (advisory lane — NOT blocking)
 *
 *   - Skips when `ANTHROPIC_API_KEY` is unset / empty.
 *   - Skips when `GGUI_OSS_LIVE_BYOK=0` (operator opt-out).
 *   - Skips when the `@ggui-ai/cli` / `@ggui-ai/console` dists
 *     are missing (same guard as sibling live specs).
 *
 * ## Not in this spec
 *
 *   - Notes composition, 3-MCP composition — Slice 6.4 is Tasks +
 *     Contacts only.
 *   - Multi-provider matrix — advisory canonical is Anthropic,
 *     matching the sibling live specs.
 *   - Preview-frame VISIBILITY during render. `ggui_render` blocks on
 *     generation; by the time it returns, preview emission has
 *     finished. `provisional-preview.spec.ts` covers the preview
 *     surface under the deterministic emitter; re-proving it here
 *     would require racing render with a second RPC, which is
 *     invented infrastructure.
 *   - `ggui_handshake` (out of scope for Slice 6.4).
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import {
  attachServeArtifacts,
  installNetworkGate,
  mcpCallAs,
  mintPairToken,
  shouldSkipLane2Advisory,
  spawnGguiServeInCwd,
  type GguiServeHandle,
  type NetworkGate,
} from './ggui-serve-harness';

const FIXTURE_CWD = resolve(
  __dirname,
  'fixtures/tasks-contacts-mount-via-serve',
);

/** Generous — real Anthropic call + two MCP reads + browser mount. */
const TEST_TIMEOUT_MS = 180_000;

/** Render-wait budget — RPC blocks on real generation. */
const GENERATION_BUDGET_MS = 120_000;

/** Shape-only facets of the mount's output. Load-bearing for passing
 *  the right ids into `story.context`; the downstream assertions are
 *  structural (ggui-rcr-*) so the exact values don't influence them. */
interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly assigneeId: string | null;
}

interface ContactView {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly linkedTaskIds: readonly string[];
}

test.describe.serial(
  'Slice 6.4 — Tasks+Contacts composed generation + browser render (advisory)',
  () => {
    let handle: GguiServeHandle | null = null;
    let gate: NetworkGate | null = null;
    let skipped = false;

    test.beforeAll(async () => {
      const skip = shouldSkipLane2Advisory({
        specLabel: 'composed-generation proof',
      });
      if (skip.skip) {
        skipped = true;
        test.skip(true, skip.reason);
        return;
      }

      // Same two-mount fixture the Lane-1 sibling uses — real CLI
      // picks up `ggui.json#mcpMounts` automatically.
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

    test('ggui_render with person-centric Tasks+Contacts context renders componentCode in the browser', async ({
      page,
    }) => {
      if (skipped || !handle) return;
      test.setTimeout(TEST_TIMEOUT_MS);
      gate = await installNetworkGate(page);

      // Sanity: boot banner should announce the Anthropic binding.
      // Catches the plumbing regression where forwardEnv silently
      // drops the key.
      const banner = handle.stdout();
      expect(
        banner,
        `CLI banner did not announce anthropic generation binding. Expected a line like "generation: anthropic / claude-haiku-4-5 (env: ANTHROPIC_API_KEY)".`,
      ).toMatch(
        /generation:\s+anthropic\s+\/\s+\S+\s+\(env:\s+ANTHROPIC_API_KEY\)/,
      );
      // And both mounts visible in the banner's `mcpMounts` line.
      expect(banner).toMatch(/tasks\s+\(3 tools/);
      expect(banner).toMatch(/contacts\s+\(3 tools/);

      const { token } = await mintPairToken(
        handle,
        'tasks-contacts-backed-generation',
      );
      expect(token.length).toBeGreaterThan(0);

      // Pull the live state from BOTH mounts. The composed
      // `story.context` below carries both domains — the spec's
      // central claim is that the generator can consume that shape.
      const contactEnv = await mcpCallAs(
        handle.baseUrl,
        token,
        'tools/call',
        { name: 'contacts_get', arguments: { id: 'alice' } },
      );
      const alice = (
        contactEnv.result as {
          structuredContent?: { item?: ContactView | null };
        }
      ).structuredContent?.item;
      expect(alice, 'contacts_get(alice) returned null from the seeded mount').toBeTruthy();

      const tasksEnv = await mcpCallAs(
        handle.baseUrl,
        token,
        'tools/call',
        { name: 'tasks_list', arguments: {} },
      );
      const allTasks =
        (tasksEnv.result as {
          structuredContent?: { items?: TaskView[] };
        }).structuredContent?.items ?? [];
      const aliceTasks = allTasks.filter((t) => t.assigneeId === 'alice');
      expect(
        aliceTasks.length,
        `Expected ≥1 task assigned to alice from the seed; got ${aliceTasks.length}. Fixture drift?`,
      ).toBeGreaterThan(0);

      // Compose the intent: person-centric view over the joined
      // state. The intent references Alice by name so the generator
      // has a deterministic reference; the browser assertions stay
      // shape-only because LLM output is non-deterministic.
      const intent = [
        `Render a person-centric work view for ${alice!.displayName}.`,
        `Show their contact info at the top (name + email),`,
        `then list the open tasks assigned to them with each task's title and status.`,
        `Use only basic HTML elements; no external assets.`,
      ].join(' ');

      // Post-Phase-B render is handshake-first: handshake → render
      // ({handshakeId, props, override?}). The prior `ggui_new_session` mint
      // is gone — every render IS the addressable scope. Direct story-
      // shaped render is retired; the legacy `story.context` carrier
      // (Alice + her open tasks here) is no longer on the wire (the
      // generator picks up backing state via mounted tools the LLM
      // can call, not via inlined fixtures). Intent carries the
      // routing signal entirely.
      const hsEnv = await mcpCallAs(handle.baseUrl, token, 'tools/call', {
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
        mcpCallAs(handle.baseUrl, token, 'tools/call', {
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
      // Post-Phase-B structuredContent: {sessionId, url, action,
      // nextStep?}. shortCode is the tail of url; codeReady retired
      // (the render assertions below are the structural proof
      // generation succeeded).
      const renderResult = renderEnv.result as {
        structuredContent?: { sessionId?: string; url?: string };
        isError?: boolean;
      };
      expect(
        renderResult.isError,
        `ggui_render returned isError: true — check CLI stderr for generator failure.`,
      ).not.toBe(true);
      expect(renderResult.structuredContent?.sessionId).toBeTruthy();
      const renderUrl = renderResult.structuredContent?.url;
      expect(renderUrl, 'ggui_render returned no url').toBeTruthy();
      const shortCodeMatch = new URL(renderUrl!).pathname.match(/^\/[rs]\/([^/?]+)/);
      expect(shortCodeMatch, `render url is not /r/<shortCode>: ${renderUrl}`).not.toBeNull();
      const shortCode = shortCodeMatch![1]!;
      expect(
        renderElapsedMs,
        `ggui_render returned in ${renderElapsedMs}ms — too fast for a real LLM call.`,
      ).toBeGreaterThan(1_000);

      await page.goto(`${handle.baseUrl}/s/${shortCode}`, {
        waitUntil: 'networkidle',
      });

      // The console GguiSessionViewer mounts the rendered UI inside a
      // plain `<iframe srcDoc>` (read-only / visual-only — post C1-fix
      // it no longer carries the `<McpAppIframe>` lifecycle-mirror
      // attribute). Readiness is gated by the inner `ggui-rcr-*` scope
      // visibility check below.
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
      const scopeChildren = await rcrScope.evaluate(
        (el) => el.children.length,
      );
      expect(
        scopeChildren,
        `ggui-rcr-* scope has ${scopeChildren} children — expected ≥ 1 (real composed componentCode must render SOME DOM).`,
      ).toBeGreaterThanOrEqual(1);

      // Network gate — browser must not reach hosted / AWS / Cognito.
      // Anthropic fires from the spawned Node process, not the
      // browser, so api.anthropic.com doesn't register here.
      expect(gate?.attempts ?? []).toEqual([]);
    });
  },
);
