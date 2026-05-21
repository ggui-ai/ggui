/**
 * Scenario 15 — `ggui_update` replace + merge both propagate to iframe DOM.
 *
 * Closes the gap scenario 7 left open. Scenario 7 stops at
 * `todo_toggle` on the domain MCP — it asserts the agent called
 * `ggui_update` is NOT in the chain, and the iframe DOM is never
 * checked post-mutation (haiku-compliance TODO captured in
 * `07-full-roundtrip-todo-toggle.spec.ts` lines 391-397). This
 * scenario drives `ggui_update` directly via the wire (no LLM
 * authorship) and asserts the iframe re-renders for BOTH wire modes:
 *
 *   - `kind: 'replace'` — full props replacement (parity with the
 *     pre-2026-05-14 wire). Single-push baseline.
 *   - `kind: 'merge'` — RFC 7396 JSON Merge Patch. Three sub-cases:
 *       (a) top-level shallow merge (replaces one key, preserves others)
 *       (b) nested deep merge (sibling fields preserved across depths)
 *       (c) null-delete (removes the field from the merged result)
 *
 * Pins the post-Slice-2 Ajv layered validation behavior:
 *   - Server applies the merge against the stored props, validates
 *     the FINAL state against propsSpec via the Ajv path
 *     (`assertPropsContract` → `validatePropsData` →
 *     `compileForValidation`).
 *   - WS `props_update` frame fans out with the merged result.
 *   - Iframe re-renders with the new props.
 *
 * One push, four updates — keeps cold-gen cost amortized over the
 * test budget. Synthetic-agent driven (no `dispatch.kind: 'agent'`
 * event-style; the wire is exercised directly from the test).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { callTool } from '../fixtures/mcp-client.js';
import { pushKnownContract } from '../fixtures/push-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

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

// Intent crafted to make DOM assertions deterministic across LLM
// rendering variance: heading + per-todo row + footer line. Asks for
// markup the iframe can re-render purely from props (no internal
// state, no buttons that mutate).
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

describe.skipIf(!HAS_KEY)(
  'Scenario 15 — ggui_update replace + merge both propagate to iframe',
  () => {
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
        // 1. Push the initial contract. Cold-gen on first run (~10-60s);
        //    cache hit on subsequent runs.
        const ref = await pushKnownContract({
          mcpUrl: MCP_URL,
          intent: INTENT,
          seed: 'scenario-15-replace-merge',
          contract: TODO_LIST_CONTRACT,
          props: INITIAL_PROPS,
        });

        // 2. Open the renderer. Post-T3-1, /r/<shortCode> mints
        //    wsUrl+token+codeUrl so bootSelfContained's live-update
        //    subscribe path activates.
        const { page } = handle;
        await page.goto(ref.url, { waitUntil: 'networkidle' });

        // 3. Initial render check. Body innerText concatenates
        //    descendant text, so we can assert content presence
        //    independent of markup structure.
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
        // "0 of 2 done" — initial summary
        await expect
          .poll(bodyText, { timeout: 5_000, interval: 200 })
          .toMatch(/0 of 2 done/i);

        // Allow the post-mount WS subscribe to settle before the
        // first server-side fan-out (no replay buffer, live-only).
        await new Promise((r) => setTimeout(r, 500));

        // ── PHASE 1 — kind: 'replace' ───────────────────────────────
        // Full props replacement: buy milk flips to completed, walk
        // dog gets a typo fix, summary updates. Mirrors the pre-2026-
        // 05-14 wire semantics; baseline that the new shape didn't
        // regress the existing path.
        await callTool(MCP_URL, 'ggui_update', {
          stackItemId: ref.stackItemId,
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
        // The summary line is the most uniquely-identifiable change.
        await expect
          .poll(bodyText, { timeout: 5_000, interval: 200 })
          .toMatch(/1 of 2 done/i);
        // The text edit on todo t2 surfaces too.
        await expect
          .poll(bodyText, { timeout: 5_000, interval: 200 })
          .toMatch(/walk the dog/i);

        // ── PHASE 2 — kind: 'merge' shallow ─────────────────────────
        // Only `title` in the patch. RFC 7396 top-level shallow merge:
        // title replaces, todos + summary preserved from the prior
        // replace. Server validates the FINAL state (post-merge)
        // against propsSpec — required fields (todos/summary) are
        // satisfied by the stored values, not by the patch.
        await callTool(MCP_URL, 'ggui_update', {
          stackItemId: ref.stackItemId,
          kind: 'merge',
          patch: { title: 'Updated Todos' },
        });
        await expect
          .poll(bodyText, { timeout: 5_000, interval: 200 })
          .toMatch(/updated todos/i);
        // Sibling preservation — buy milk's completed=true from phase 1
        // must STILL show (summary line still "1 of 2 done").
        await expect
          .poll(bodyText, { timeout: 5_000, interval: 200 })
          .toMatch(/1 of 2 done/i);

        // ── PHASE 3 — kind: 'merge' nested-deep ─────────────────────
        // Patch into summary's `completed` only. RFC 7396 recurses
        // into the nested object: `summary.total` (2) MUST be
        // preserved while `summary.completed` updates 1 → 2. The
        // sibling-preservation guarantee is what distinguishes
        // RFC 7396 from shallow object replacement.
        await callTool(MCP_URL, 'ggui_update', {
          stackItemId: ref.stackItemId,
          kind: 'merge',
          patch: { summary: { completed: 2 } },
        });
        await expect
          .poll(bodyText, { timeout: 5_000, interval: 200 })
          .toMatch(/2 of 2 done/i);
        // Title from phase 2 still present (top-level sibling preserved).
        await expect
          .poll(bodyText, { timeout: 5_000, interval: 200 })
          .toMatch(/updated todos/i);

        // ── PHASE 4 — kind: 'merge' contract violation ─────────────
        // Required-field-violating patch: null-delete a required
        // field (`todos`). The Ajv-backed final-state validation
        // catches this — server rejects with ContractViolationError,
        // and the iframe DOM stays on the phase-3 state (no fan-out).
        // Pins the layer-C closed-shape rejection.
        //
        // `callTool` returns the JSON-RPC envelope verbatim and only
        // throws on HTTP transport error. Tool-level violations come
        // back as `result.isError === true` (with the violation in
        // `result.content`) OR as a JSON-RPC `error`. Check both.
        const violationResp = await callTool(MCP_URL, 'ggui_update', {
          stackItemId: ref.stackItemId,
          kind: 'merge',
          patch: { todos: null },
        });
        const wasRejected =
          violationResp.error !== undefined ||
          violationResp.result?.isError === true;
        // eslint-disable-next-line no-console
        console.log(
          '[scenario-15] null-delete-of-required-field response:',
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

        // DOM remains on phase-3 state (no successful fan-out).
        await expect
          .poll(bodyText, { timeout: 2_000, interval: 200 })
          .toMatch(/2 of 2 done/i);
      },
      // Cold-gen p95 ~60s + four updates × <5s each + slack.
      120_000,
    );
  },
);
