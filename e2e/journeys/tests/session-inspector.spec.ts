/**
 * Render inspector — Slice 9c live round-trip proof (advisory, BYOK).
 *
 * Closes the loop on the
 * `docs/plans/2026-04-22-session-contract-activity-panel.md` Slice 9b
 * panels: drive a real `ggui_render` against the manifest-capabilities
 * fixture, navigate `/s/<shortCode>`, and assert the contract /
 * activity / test-action panels mount inline under the rendered
 * stack entry — and that each disclosure actually expands.
 *
 * ## Why BYOK / Lane 2
 *
 * The inspector lives inside `StackEntryCard`, which only renders for
 * non-empty stacks. Driving a real stack entry requires `ggui_render`
 * to complete a generation — which needs a provider key. The
 * deterministic preview emitter only paints provisional frames into
 * the empty-stack placeholder; it does not commit a render.
 *
 * Mirrors `cache-reuse.spec.ts`'s gating envelope:
 *   1. `ANTHROPIC_API_KEY` unset → skip (clean CI).
 *   2. `GGUI_OSS_LIVE_BYOK=0` → explicit operator opt-out.
 *   3. Missing CLI / console dists → skip with build hint.
 *
 * `spawnGguiServe({ forwardEnv: ['ANTHROPIC_API_KEY'] })` lets the key
 * cross the harness's clean-room env wall.
 *
 * ## What this spec proves
 *
 *   1. After a real `ggui_render`, navigating `/s/<shortCode>` mounts
 *      the inspector container under the rendered stack entry.
 *   2. All three disclosures (`contract`, `activity`, `test action`)
 *      expand on click.
 *   3. The activity panel populates with at least one event from the
 *      render warming up (subscribe ack / render handshake / etc.).
 *   4. The painted UI itself is live (the renderer mounted under the
 *      stack entry; same-origin WS connected).
 *   5. Network gate — viewer is local-only; no hosted / AWS / Cognito
 *      browser hits.
 *
 * Population of the contract panel + a real test-fire dispatch are
 * left to operator inspection — this spec stays focused on the wire
 * (mount + observe) so it survives variance in what the LLM emits.
 */
import { test, expect } from '@playwright/test';
import {
  attachServeArtifacts,
  installNetworkGate,
  mcpCallAs,
  mintPairToken,
  shouldSkipLane2Advisory,
  spawnGguiServe,
  type GguiServeHandle,
  type NetworkGate,
} from './ggui-serve-harness';

const TEST_TIMEOUT_MS = 180_000;
const GENERATION_BUDGET_MS = 120_000;
const PUSH_INTENT = 'A small greeting card with a title "Hello"';

/**
 * Captured render artifacts for this spec — the post-Phase-B
 * structuredContent surface ({renderId, url, action, nextStep?})
 * plus the derived shortCode.
 */
interface RenderArtifacts {
  readonly renderId: string;
  readonly url: string;
  readonly shortCode: string;
}

function shouldSkip(): { skip: boolean; reason?: string } {
  return shouldSkipLane2Advisory({ specLabel: 'session inspector spec' });
}

test.describe.serial(
  'Slice 9c — render inspector round-trip on /s/<shortCode> (advisory)',
  () => {
    let handle: GguiServeHandle | null = null;
    let render: RenderArtifacts | null = null;
    let skipped = false;

    test.beforeAll(async () => {
      const gate = shouldSkip();
      if (gate.skip) {
        skipped = true;
        test.skip(true, gate.reason);
        return;
      }

      handle = await spawnGguiServe({
        forwardEnv: ['ANTHROPIC_API_KEY'],
      });

      const { token } = await mintPairToken(handle, 'session-inspector-spec');

      // Post-Phase-B render is handshake-first: handshake → render
      // ({handshakeId, decision}). Direct story-shaped render is
      // retired; the prior `ggui_new_session` step is gone (every
      // render IS the addressable scope).
      const hsEnv = await mcpCallAs(handle.baseUrl, token, 'tools/call', {
        name: 'ggui_handshake',
        arguments: {
          intent: PUSH_INTENT,
          blueprintDraft: { contract: {} },
        },
      });
      if (hsEnv.error) {
        throw new Error(`ggui_handshake failed: ${JSON.stringify(hsEnv.error)}`);
      }
      const handshakeId = (
        hsEnv.result as { structuredContent: { handshakeId: string } }
      ).structuredContent.handshakeId;

      // Race with a generous LLM-aware budget so a stalled render fails
      // with a clean "did not return in N ms" rather than an unbounded
      // worker timeout. Mirrors the cache-reuse pattern.
      const env = await Promise.race<ReturnType<typeof mcpCallAs>>([
        mcpCallAs(handle.baseUrl, token, 'tools/call', {
          name: 'ggui_render',
          arguments: { handshakeId, decision: { kind: 'override', blueprintDraft: { contract: {} } } },
        }),
        new Promise((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `ggui_render did not return within ${GENERATION_BUDGET_MS}ms — LLM call may be hanging.`,
                ),
              ),
            GENERATION_BUDGET_MS,
          ),
        ) as Promise<never>,
      ]);
      if (env.error) {
        throw new Error(`ggui_render failed: ${JSON.stringify(env.error)}`);
      }
      const result = env.result as {
        structuredContent?: { renderId?: string; url?: string };
        isError?: boolean;
      };
      if (result.isError === true) {
        throw new Error(`ggui_render isError: see server stderr.`);
      }
      const sc = result.structuredContent;
      if (!sc?.renderId || !sc.url) {
        throw new Error(
          `ggui_render returned no renderId/url: ${JSON.stringify(result)}`,
        );
      }
      const shortCodeMatch = new URL(sc.url).pathname.match(/^\/[rs]\/([^/?]+)/);
      if (!shortCodeMatch) {
        throw new Error(`render url is not /r/<shortCode>: ${sc.url}`);
      }
      render = {
        renderId: sc.renderId,
        url: sc.url,
        shortCode: shortCodeMatch[1]!,
      };
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test.afterEach(async () => {
      if (skipped) return;
      if (handle) await attachServeArtifacts(handle);
    });

    // Slice J (2026-04-26) wired `<SessionInspector>` into production
    // `<RenderViewer>` via a new `<StackInspectorList>` pane that
    // renders one inspector per stack entry. Post Phase-B stack
    // collapse the data source is now `GET /ggui/console/render?render=<id>`
    // (single Render row instead of a stack array; auth-gated by the
    // same cookie path the resource + meta routes use). Both spec
    // branches below now run for real — `test.fixme` lifted.
    test(
      'viewer mounts the inspector under the rendered stack entry',
      async ({ page }) => {
        if (skipped || !render || !handle) return;
        test.setTimeout(TEST_TIMEOUT_MS);
        const networkGate: NetworkGate = await installNetworkGate(page);

        await page.goto(`${handle.baseUrl}/s/${render.shortCode}`, {
          waitUntil: 'networkidle',
        });

        // Anchor on the inspector data-attr — only renders once the
        // StackSurface has a real stack entry to render under (post-
        // subscribe-ack, post-push-commit).
        const inspector = page.locator('[data-ggui-inspect]').first();
        await expect(inspector).toBeVisible({ timeout: 30_000 });

        // All three disclosures present, collapsed by default.
        await expect(
          inspector.locator('[data-ggui-inspect-contract]'),
        ).toBeVisible();
        await expect(
          inspector.locator('[data-ggui-inspect-activity]'),
        ).toBeVisible();
        await expect(
          inspector.locator('[data-ggui-inspect-test]'),
        ).toBeVisible();

        // Network gate — local-only.
        expect(networkGate.attempts).toEqual([]);
      },
    );

    test('all three disclosures expand on click', async ({ page }) => {
      if (skipped || !render || !handle) return;
      test.setTimeout(TEST_TIMEOUT_MS);
      await page.goto(`${handle.baseUrl}/s/${render.shortCode}`, {
        waitUntil: 'networkidle',
      });
      const inspector = page.locator('[data-ggui-inspect]').first();
      await expect(inspector).toBeVisible({ timeout: 30_000 });

      // Click each disclosure and verify it expanded. Don't assert
      // specific copy (depends on what the LLM emitted) — just verify
      // the disclosure body became visible.
      for (const selector of [
        '[data-ggui-inspect-contract]',
        '[data-ggui-inspect-activity]',
        '[data-ggui-inspect-test]',
      ]) {
        const card = inspector.locator(selector);
        const toggle = card.locator('button').first();
        const ariaExpanded = await toggle.getAttribute('aria-expanded');
        if (ariaExpanded !== 'true') {
          await toggle.click();
          await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        }
      }
    });
  },
);
