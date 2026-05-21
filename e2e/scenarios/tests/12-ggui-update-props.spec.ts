/**
 * Scenario 12 — `ggui_update` props propagate to a live iframe (B6).
 *
 * Locks in the B4 fix: when a renderer iframe is mounted via
 * `bootSelfContained` AND the bootstrap carries the live trio
 * (wsUrl + token + stackItemId), a server-side `ggui_update` MUST
 * propagate to the iframe over WS so React re-renders with new props.
 *
 * Pre-B4 (`bd5926fae`): bootSelfContained mounted React but never
 * opened a WebSocket, so `ggui_update` succeeded server-side and the
 * frame fanned out, but the iframe never subscribed — props_update
 * silently dropped. This scenario asserts that path is fixed.
 *
 * Setup: push a contract with a `propsSpec.count` numeric prop +
 * initial `props: {count: 0}`. Intent steers the LLM to render
 * `Count: <props.count>` so we can assert by visible text. Open the
 * `/r/<shortCode>` URL (which mounts via `bootSelfContained` post-T3-1
 * since the route now mints wsUrl+token+codeUrl together). Wait for
 * initial `Count: 0`. Call `ggui_update` with `props: {count: 42}`.
 * Assert `Count: 42` becomes visible.
 *
 * The arbitrary number `42` avoids accidental matches against the
 * initial `0` or any UI chrome digits — if the LLM hard-codes the
 * count rather than reading `props.count`, the test correctly fails.
 *
 * Gated on `ANTHROPIC_API_KEY` because push triggers cold-gen on the
 * first run (this contract is unique to scenario 12 — no cache hit
 * from the SHARED_CONTRACT used by 01/02/03).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { callTool } from '../fixtures/mcp-client.js';
import { pushKnownContract } from '../fixtures/push-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

const PROPS_INTENT =
  "render a single text element displaying the current count value in the format 'Count: <value>'. read the value from props.count. no buttons, no inputs, no animations — just the text. when props.count changes, the text MUST update to reflect the new value.";

const PROPS_CONTRACT = {
  propsSpec: {
    properties: {
      count: {
        schema: { type: 'integer' },
        required: true,
      },
    },
  },
} as const;

describe.skipIf(!HAS_KEY)(
  'Scenario 12 — ggui_update props propagate to iframe',
  () => {
    let handle: BrowserHandle;
    beforeEach(async () => {
      handle = await openBrowser();
    });
    afterEach(async () => {
      await handle.close();
    });

    test(
      'initial props render; ggui_update with new props triggers re-render',
      async () => {
        // 1. Push a contract with propsSpec.count + initial count=0.
        const ref = await pushKnownContract({
          mcpUrl: MCP_URL,
          intent: PROPS_INTENT,
          seed: 'scenario-12-props-update',
          contract: PROPS_CONTRACT,
          props: { count: 0 },
        });

        // 2. Open the renderer URL. `/r/<shortCode>` mints a bootstrap
        //    with wsUrl + token + codeUrl since Slice 1 (`84041b476`),
        //    so the autostart picks bootSelfContained (static content
        //    present) and B4's live-update subscribe path kicks in.
        const { page } = handle;
        await page.goto(ref.url, { waitUntil: 'networkidle' });

        // 3. Wait for initial render. 90s budget mirrors scenario 01 —
        //    cold-gen + fetch(codeUrl) + dynamic import + react paint.
        //    The intent asks for "Count: <value>". The LLM may split
        //    label and value across sibling DOM nodes, so we assert on
        //    the body's flattened innerText (which concatenates
        //    descendants with whitespace) containing the word "Count"
        //    AND the value 0 — robust to any markup arrangement.
        await expect
          .poll(async () => await page.locator('body').innerText(), {
            timeout: 90_000,
            interval: 500,
          })
          .toMatch(/count/i);
        await expect
          .poll(async () => await page.locator('body').innerText(), {
            timeout: 5_000,
            interval: 200,
          })
          .toMatch(/\b0\b/);

        // Brief pause so the post-mount fire-and-forget WS subscribe
        // can settle before we fire ggui_update — without this, the
        // server-side fan-out can race ahead of the iframe's subscribe-
        // ack and drop the frame (live-only, no replay buffer).
        await new Promise((r) => setTimeout(r, 500));

        // 4. Call ggui_update with new props. Server fans out a
        //    props_update WS frame keyed on this stackItemId.
        //    Post-2026-05-14: `kind` discriminator is required —
        //    `kind:'replace'` mirrors the pre-discriminator semantic
        //    (full props replacement). `kind:'merge'` exercises the
        //    RFC 7396 path; covered separately.
        await callTool(MCP_URL, 'ggui_update', {
          stackItemId: ref.stackItemId,
          kind: 'replace',
          props: { count: 42 },
        });

        // 5. Assert the iframe re-renders with the new count. Poll
        //    body innerText for the new value. "42" is intentionally
        //    uncommon (unlikely to appear in chrome) so a substring
        //    match is enough; we don't need to assert adjacency to
        //    "Count" — the value-only swap is sufficient evidence of
        //    propagation. 5s budget absorbs scheduler jitter; the WS
        //    round-trip + React re-render should be sub-second.
        await expect
          .poll(async () => await page.locator('body').innerText(), {
            timeout: 5_000,
            interval: 200,
          })
          .toMatch(/\b42\b/);
        // Also confirm the OLD value disappeared — guards against the
        // (unlikely) case where 42 appears in addition to 0 rather
        // than replacing it. Inverse-of-the-initial check.
        await expect
          .poll(async () => await page.locator('body').innerText(), {
            timeout: 2_000,
            interval: 200,
          })
          .not.toMatch(/\b0\b/);
      },
      // 90s ceiling × cold-gen + a few seconds for the propagation.
      // Match scenario 01's overall budget.
      120_000,
    );
  },
);
