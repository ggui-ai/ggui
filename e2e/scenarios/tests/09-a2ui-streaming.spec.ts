/**
 * Scenario 9 — A2UI provisional preview streams during cold-gen.
 *
 * OSS `ggui serve` wires a deterministic provisional-preview emitter
 * (`createDeterministicPreviewEmitter`) on `provisionalPreview.emitter`.
 * The handler kicks off the emitter at push time, BEFORE
 * `runGenerationIntoSession` calls the real LLM. Frames stream over
 * the reserved `_ggui:preview` channel, and the iframe-runtime's
 * `mountProvisional` renders the A2UI surface visibly while cold-gen
 * runs in the background. When the authoritative componentCode lands,
 * the provisional surface is replaced in-place.
 *
 * Wire-contract this scenario locks:
 *
 *   1. `push` returns FAST (before LLM completes), with a placeholder
 *      stack item appended.
 *   2. Iframe shows visible content within a few seconds of `goto`
 *      (the A2UI provisional surface) — the user is NEVER staring at
 *      a blank screen during cold-gen.
 *   3. The final component eventually replaces the provisional surface
 *      (within the 90s cold-gen budget).
 *
 * Cache is cleared between e2e runs (global-setup wipes
 * GGUI_CODE_CACHE_DIR + restarts ggui-default with fresh in-memory
 * vectorStore), so this scenario always exercises the cold path.
 *
 * Gated on `ANTHROPIC_API_KEY` — push triggers real cold-gen.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { pushKnownContract } from '../fixtures/push-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_KEY)(
  'Scenario 9 — A2UI provisional preview streams during cold-gen',
  () => {
    let handle: BrowserHandle;
    beforeEach(async () => {
      handle = await openBrowser();
    });
    afterEach(async () => {
      await handle.close();
    });

    test(
      'iframe shows provisional A2UI content before final component lands',
      async () => {
        // Unique seed so this scenario never hits the in-memory
        // generation cache from prior tests in the same run.
        const seed = `a2ui-stream-${Date.now()}`;
        const ref = await pushKnownContract({
          mcpUrl: MCP_URL,
          intent:
            'one form with a single text input labeled Email and a Submit button',
          seed,
          contract: {
            actionSpec: {
              submit: {
                label: 'Submit',
              },
            },
          },
        });

        const { page } = handle;
        await page.goto(ref.url, { waitUntil: 'networkidle' });

        // The provisional A2UI surface should mount within a few
        // seconds of page load — far before cold-gen completes. We
        // assert that SOME visible content exists in the iframe long
        // before the final "Submit" button could possibly land.
        //
        // Heuristic: the iframe-runtime mounts into `#ggui-root` (the
        // self-contained shell's inline mount point). Polling that
        // element for non-empty inner content within 8s captures the
        // provisional render WITHOUT racing the real component (which
        // takes 10–60s on cold-gen).
        const root = page.locator('#ggui-root');
        await root.waitFor({ state: 'attached', timeout: 5_000 });

        // Poll for non-empty content. The provisional surface renders
        // SOMETHING — could be a skeleton form, a card outline, a
        // loading spinner. We don't pin the exact shape (LLM-side
        // emitter heuristics can drift); the lock is "user sees
        // SOMETHING before cold-gen completes."
        let sawProvisionalContent = false;
        const provisionalDeadline = Date.now() + 8_000;
        while (Date.now() < provisionalDeadline) {
          const text = await root.innerText().catch(() => '');
          if (text.trim().length > 0) {
            sawProvisionalContent = true;
            break;
          }
          await page.waitForTimeout(200);
        }
        expect(sawProvisionalContent).toBe(true);

        // Final mount — the authoritative componentCode replaces the
        // provisional surface. 90s budget covers cold-gen + fetch(
        // codeUrl) + dynamic import + react paint.
        const submit = page.getByRole('button', { name: /submit/i });
        await submit.first().waitFor({ state: 'visible', timeout: 90_000 });
      },
      120_000,
    );
  },
);
