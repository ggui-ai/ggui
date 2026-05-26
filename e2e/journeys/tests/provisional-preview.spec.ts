/**
 * Phase 5 / OSS full-generation — Slice 1: deterministic A2UI
 * provisional preview, end-to-end on the OSS product surface.
 *
 * Proves the slice's claim: a freshly-spawned `ggui serve` actually
 * paints provisional A2UI frames into the user-visible
 * `/s/<shortCode>` viewer the first time an agent calls `ggui_push`,
 * with no LLM, no real generation, no BYOK, no `ggui_handshake`.
 *
 *   1. Boot `ggui serve` under the standard clean-room harness.
 *   2. Mint a pair token (strict-auth `/mcp` requires a real bearer).
 *   3. Call `tools/call ggui_push` with an intent that triggers the
 *      deterministic emitter's `form` shell heuristic ("Show me a
 *      sign-up form for my app"). The handler appends a placeholder
 *      stack item (empty componentCode), which the iframe-runtime's
 *      `stack-item-renderer.ts` routes to `mountProvisional` — that's
 *      the surface the deterministic frames paint into.
 *   4. Navigate the browser to the returned `/s/<shortCode>` viewer.
 *   5. Wait for the live-channel connection to come up + the
 *      provisional renderer mounted PER-STACK-ITEM (post-C9.5
 *      doctrine) to receive the deterministic frames over
 *      `_ggui:preview`.
 *   6. Assert the preview surface paints the intent-derived heading
 *      AND the form-shell shape (TextField label + "Submit" button).
 *   7. Confirm the hosted-network gate stayed at `[]` — preview frames
 *      live entirely on the local channel.
 *
 * Selector strategy: the iframe-runtime's `mountProvisional` paints
 * the A2UI surface inside `<PreviewSurface>` (from
 * `@ggui-ai/design/preview`) which emits `data-ggui-preview=""`. That
 * attribute IS the anchor; before the A2UI `root` fragment arrives,
 * `<PreviewSurface>` isn't mounted yet — the fallback Spinner is.
 * So waiting for `data-ggui-preview` to appear in the iframe's DOM
 * is the same as waiting for "root fragment landed", which is what
 * the spec actually wants.
 *
 * Lane 1 of the 4-lane test taxonomy (browser + spawned CLI, no LLM,
 * blocking every PR, <60s).
 */
import { test, expect } from '@playwright/test';
import {
  attachServeArtifacts,
  DEVTOOL_DIST,
  GGUI_CLI_DIST,
  installNetworkGate,
  mcpCallAs,
  mintPairToken,
  spawnGguiServe,
  type GguiServeHandle,
  type NetworkGate,
} from './ggui-serve-harness';
import { existsSync } from 'node:fs';

const TEST_TIMEOUT_MS = 60_000;
const PUSH_INTENT = 'Show me a sign-up form for my app';

test.describe.serial(
  'Slice 1 — deterministic A2UI provisional preview on /s/<shortCode>',
  () => {
    let handle: GguiServeHandle;
    let gate: NetworkGate;

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
      handle = await spawnGguiServe();
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test.afterEach(async () => {
      if (handle) await attachServeArtifacts(handle);
    });

    test('ggui_push fires preview emitter; viewer paints heading + form shell', async ({ page }) => {
      // The provisional preview is the pre-LLM stand-in shown while a
      // real generator runs. With `ANTHROPIC_API_KEY` set, the OSS
      // generator runs synchronously enough that the provisional
      // frame can be replaced before the test observes
      // `[data-ggui-preview]`. This is correct production behaviour —
      // the preview is transient by design — so skip the assertion
      // when a real LLM is wired in. The no-key posture (CI default)
      // still exercises the deterministic emitter end-to-end.
      if (process.env['ANTHROPIC_API_KEY']) {
        test.skip(
          true,
          'provisional-preview asserts the pre-LLM stand-in; with ANTHROPIC_API_KEY set, real generation runs first and the transient preview frame is no longer the load-bearing render.',
        );
        return;
      }
      test.setTimeout(TEST_TIMEOUT_MS);
      gate = await installNetworkGate(page);

      // 1. Mint a pair-minted bearer — strict /mcp auth requires it.
      const { token } = await mintPairToken(handle, 'preview-slice-1');
      expect(token.length).toBeGreaterThan(0);

      // 2. Mint session + handshake + push. The deterministic emitter's
      //    keyword heuristic recognises "sign-up" / "form" and emits the
      //    form-shell fragment set (Card → Column → TextField{label:
      //    "Input"} + Button{label:"Submit"}). Independent of LLM
      //    availability — fully reproducible. Post-Slice-5 push is
      //    handshake-first.
      const sessEnv = await mcpCallAs(handle.baseUrl, token, 'tools/call', {
        name: 'ggui_new_session',
        arguments: {},
      });
      const sessionId = (
        sessEnv.result as { structuredContent: { sessionId: string } }
      ).structuredContent.sessionId;
      const hsEnv = await mcpCallAs(handle.baseUrl, token, 'tools/call', {
        name: 'ggui_handshake',
        arguments: {
          sessionId,
          intent: PUSH_INTENT,
          blueprintDraft: { contract: {} },
        },
      });
      const handshakeId = (
        hsEnv.result as { structuredContent: { handshakeId: string } }
      ).structuredContent.handshakeId;

      const pushEnv = await mcpCallAs(handle.baseUrl, token, 'tools/call', {
        name: 'ggui_push',
        arguments: { handshakeId, decision: { kind: 'override', blueprintDraft: { contract: {} } } },
      });
      expect(pushEnv.error).toBeUndefined();
      // Post-Slice-5 structuredContent: {stackItemId, url, action,
      // nextStep?}. `shortCode` is derived from the url tail.
      const pushResult = pushEnv.result as {
        structuredContent?: { stackItemId?: string; url?: string };
      };
      const pushUrl = pushResult.structuredContent?.url;
      expect(pushUrl, 'ggui_push returned no url').toBeTruthy();
      const shortCodeMatch = new URL(pushUrl!).pathname.match(/^\/[rs]\/([^/?]+)/);
      expect(shortCodeMatch, `push url is not /r/<shortCode>: ${pushUrl}`).not.toBeNull();
      const shortCode = shortCodeMatch![1]!;

      // 3. Navigate to the same-origin viewer. The cookie mint +
      //    /ws subscribe happen automatically on render; if either
      //    leg breaks, the lifecycle attribute below stays stuck and
      //    the spec fails fast.
      await page.goto(`${handle.baseUrl}/s/${shortCode}`, {
        waitUntil: 'networkidle',
      });

      // 4. The console SessionViewer mounts the rendered session
      //    inside a plain `<iframe srcDoc>` (read-only / visual-only
      //    — post C1-fix it no longer carries the `<McpAppIframe>`
      //    lifecycle-mirror attribute). Inner connection-status text
      //    lives INSIDE the iframe and is reachable only via
      //    `frameLocator`. Readiness is gated by the inner
      //    `data-ggui-preview` assertion below.
      const liveIframe = page
        .locator('iframe[data-testid="session-viewer-iframe"]')
        .first();
      await expect(liveIframe).toBeVisible({ timeout: 15_000 });

      // Renderer DOM is reachable via frameLocator below.
      const frame = page
        .frameLocator('iframe[data-testid="session-viewer-iframe"]')
        .first();

      // 5. Wait for the deterministic emitter's frames to arrive
      //    AND the A2UI `root` fragment to land — at that point
      //    `mountProvisional` swaps the fallback Spinner for
      //    `<PreviewSurface>`, which emits `data-ggui-preview=""`.
      //    Before the root fragment arrives, this attribute is not
      //    in the DOM. So waiting for it to appear is equivalent to
      //    "the preview channel delivered a root fragment", which is
      //    the load-bearing claim of the slice. The deterministic
      //    emitter sends frames in series with no artificial delay —
      //    this should resolve in <1s on a healthy machine.
      const previewSurface = frame.locator('[data-ggui-preview]');
      await expect(previewSurface).toBeVisible({ timeout: 15_000 });

      // 6. Heading derived from `story.intent`. The emitter
      //    capitalises the leading character + clips at the first
      //    sentence boundary, so the input "Show me a sign-up form
      //    for my app" emits the same string back as a level-2
      //    heading inside the surface.
      await expect(previewSurface).toContainText(PUSH_INTENT);

      // 7. Form-shell fragments — proves the keyword heuristic
      //    fired (and proves the renderer mapped the A2UI Catalog
      //    types to real primitives, not fallback shells).
      await expect(previewSurface).toContainText('Input'); // TextField label
      await expect(previewSurface).toContainText('Submit'); // Button label

      // 8. Network gate — preview frames are local-channel only;
      //    no hosted / AWS / Cognito calls should leak.
      expect(gate.attempts).toEqual([]);
    });
  },
);
