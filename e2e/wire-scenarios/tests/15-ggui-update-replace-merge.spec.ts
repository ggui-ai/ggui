/**
 * Scenario 15 — `ggui_update` replace + merge both propagate to iframe DOM.
 *
 * Closes the gap scenario 7 left open. Drives `ggui_update` directly
 * via the wire (no LLM authorship) and asserts the iframe re-renders
 * for BOTH wire modes:
 *
 *   - `kind: 'replace'` — full props replacement (parity with the
 *     pre-2026-05-14 wire). Single-push baseline.
 *   - `kind: 'merge'` — RFC 7396 JSON Merge Patch. Three sub-cases:
 *       (a) top-level shallow merge (replaces one key, preserves others)
 *       (b) nested deep merge (sibling fields preserved across depths)
 *       (c) null-delete (removes the field from the merged result)
 *
 * Parametric over the model-provider axis. See provider-matrix.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { callTool } from '../fixtures/mcp-client.js';
import { pushKnownContract } from '../fixtures/push-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { PROVIDERS, REQUIRE_ALL, providerSkip } from '../fixtures/provider-matrix.js';

// Multi-prop contract — exercises BOTH the array path (todos) and the
// nested-object path (summary) under RFC 7396 deep-merge semantics.
const TODO_LIST_CONTRACT = {
  propsSpec: {
    properties: {
      title: {
        schema: { type: 'string' },
        required: true,
      },
      todos: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              completed: { type: 'boolean' },
            },
          },
        },
        required: true,
      },
      summary: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            completed: { type: 'integer' },
          },
        },
        required: true,
      },
    },
  },
} as const;

const INTENT = [
  'Render a todo list display:',
  '(1) An h1 heading containing the value of props.title.',
  '(2) A list of props.todos — each row shows the value of props.todos[i].text',
  "    AND a visible indicator of props.todos[i].completed (a checkbox whose 'checked'",
  '    attribute reflects the boolean is sufficient).',
  '(3) A footer line showing the literal text',
  "    '<props.summary.completed> of <props.summary.total> done'",
  '    (substitute the actual values from props).',
  'Re-render automatically when props change. No buttons that mutate state,',
  'no inputs, no controls — purely a display of the props.',
].join(' ');

const INITIAL_PROPS = {
  title: 'My Todos',
  todos: [
    { id: 't1', text: 'buy milk', completed: false },
    { id: 't2', text: 'walk dog', completed: false },
  ],
  summary: { total: 2, completed: 0 },
} as const;

for (const provider of PROVIDERS) {
  const hasKey = !!process.env[provider.apiKey];
  describe.skipIf(providerSkip(provider))(
    `Scenario 15 [${provider.name}] — ggui_update replace + merge both propagate to iframe`,
    () => {
      if (!hasKey) {
        test(`${provider.apiKey} missing (REQUIRE_ALL_PROVIDERS=${REQUIRE_ALL ? '1' : '0'})`, () => {
          throw new Error(
            `GGUI_E2E_REQUIRE_ALL_PROVIDERS=1 but ${provider.apiKey} is not set — ` +
              `the ${provider.name} row cannot run.`,
          );
        });
        return;
      }
      const MCP_URL = provider.mcpUrl;
      let handle: BrowserHandle;
      beforeEach(async () => {
        handle = await openBrowser();
      });
      afterEach(async () => {
        await handle.close();
      });

      test(
        'replace, merge shallow, merge nested-deep, and merge null-delete all reach the iframe DOM',
        async () => {
          // 1. Push the initial contract.
          const ref = await pushKnownContract({
            mcpUrl: MCP_URL,
            intent: INTENT,
            seed: `scenario-15-replace-merge-${provider.name}`,
            contract: TODO_LIST_CONTRACT,
            props: INITIAL_PROPS,
          });

          // 2. Open the renderer.
          const { page } = handle;
          await page.goto(ref.url, { waitUntil: 'networkidle' });

          // 3. Initial render check.
          const bodyText = async () => await page.locator('body').innerText();
          await expect
            .poll(bodyText, { timeout: 90_000, interval: 500 })
            .toMatch(/my todos/i);
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/buy milk/i);
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/walk dog/i);
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/0 of 2 done/i);

          // Allow the post-mount WS subscribe to settle.
          await new Promise((r) => setTimeout(r, 500));

          // ── PHASE 1 — kind: 'replace' ───────────────────────────────
          await callTool(MCP_URL, 'ggui_update', {
            renderId: ref.renderId,
            kind: 'replace',
            props: {
              title: 'My Todos',
              todos: [
                { id: 't1', text: 'buy milk', completed: true },
                { id: 't2', text: 'walk the dog', completed: false },
              ],
              summary: { total: 2, completed: 1 },
            },
          });
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/1 of 2 done/i);
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/walk the dog/i);

          // ── PHASE 2 — kind: 'merge' shallow ─────────────────────────
          await callTool(MCP_URL, 'ggui_update', {
            renderId: ref.renderId,
            kind: 'merge',
            patch: { title: 'Updated Todos' },
          });
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/updated todos/i);
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/1 of 2 done/i);

          // ── PHASE 3 — kind: 'merge' nested-deep ─────────────────────
          await callTool(MCP_URL, 'ggui_update', {
            renderId: ref.renderId,
            kind: 'merge',
            patch: { summary: { completed: 2 } },
          });
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/2 of 2 done/i);
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/updated todos/i);

          // ── PHASE 4 — kind: 'merge' contract violation ─────────────
          const violationResp = await callTool(MCP_URL, 'ggui_update', {
            renderId: ref.renderId,
            kind: 'merge',
            patch: { todos: null },
          });
          const wasRejected =
            violationResp.error !== undefined ||
            violationResp.result?.isError === true;
          // eslint-disable-next-line no-console
          console.log(
            `[scenario-15:${provider.name}] null-delete-of-required-field response:`,
            JSON.stringify(
              violationResp.error ?? violationResp.result,
              null,
              2,
            ).slice(0, 400),
          );
          expect(
            wasRejected,
            'expected ggui_update with patch {todos: null} on a required field to reject',
          ).toBe(true);

          // DOM remains on phase-3 state.
          await expect
            .poll(bodyText, { timeout: 2_000, interval: 200 })
            .toMatch(/2 of 2 done/i);
        },
        120_000,
      );
    },
  );
}
