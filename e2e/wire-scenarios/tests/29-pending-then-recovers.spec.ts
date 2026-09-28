/**
 * Scenario 29 — the repeatable-control check, pinned on fixed cards.
 *
 * Scenario 3 asserts that a generated card's repeatable `save` control
 * survives its own gesture, using `expectSaveStillRepeatable`. Since
 * ggui#1398 that check has two branches: the control stays an enabled
 * `/save/i` control, or it goes pending (`disabled`, `aria-busy`,
 * relabelled "Saving…") and comes back within the runtime's pending bound.
 * A generated card draws either one, so a green scenario 3 does not say
 * which branch ran. This scenario pins the check itself, with no model:
 *
 *   1. A card written the way the teach writes it: the button renders
 *      from `useActionPending('save')`. After the tap it is observed
 *      pending ("Saving…", `aria-busy`), and the check passes once the
 *      pending state clears: when the card is next repainted (in this
 *      harness, within seconds of the tap) or, at the latest, when the
 *      runtime's 20 s bound passes.
 *   2. A card that guards `save` for good: the action is declared
 *      `oneShot` and the button renders from `useActionSpent('save')`,
 *      the runtime's durable spent state, so after one tap it stays
 *      disabled. The check must REJECT it, with its "was guarded after
 *      firing" message. This is the negative control: a check that passes
 *      both cards detects nothing. (A component-local `useState` lock is
 *      NOT a durable guard: the card is repainted after the tap and the
 *      local state resets, which is how a first cut of this control
 *      passed the check.)
 *
 * Both cards are registered through `/control` with pre-built bytes (the
 * scenario-18 recipe), so this is keyless and runs in the keyless sweep.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import {
  MCP_APP_IFRAME_SELECTOR,
  mountRenderResource,
  type McpAppHostHandle,
} from '../fixtures/mcp-app-host.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { expectSaveStillRepeatable } from '../fixtures/repeatable-control.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const CONTROL_URL = `http://localhost:${GGUI_PORT}/control`;

/** A `save` action; the description keeps each card's contract (and cache key) its own. */
function saveContract(description: string, oneShot: boolean) {
  return {
    propsSpec: { description, properties: {} },
    actionSpec: { save: oneShot ? { label: 'Save', oneShot: true } : { label: 'Save' } },
  };
}

const PENDING_CONTRACT = saveContract('scenario 29 — a Save button that shows pending', false);
const GUARDED_CONTRACT = saveContract('scenario 29 — a Save button that guards itself for good', true);

/** The teach's shape: the dispatching control renders from its action's pending state. */
const PENDING_CARD = [
  'import { jsx } from "react/jsx-runtime";',
  'import { useAction, useActionPending } from "@ggui-ai/wire";',
  'export default function PendingSaveCard() {',
  '  const save = useAction("save");',
  '  const savePending = useActionPending("save");',
  '  return jsx("button", {',
  '    type: "button",',
  '    disabled: savePending,',
  '    "aria-busy": savePending,',
  '    onClick: () => save({}),',
  '    children: savePending ? "Saving…" : "Save",',
  '  });',
  '}',
  '',
].join('\n');

/** Guarded for good: one tap spends the action, and the runtime's spent state outlives a repaint. */
const GUARDED_CARD = [
  'import { jsx } from "react/jsx-runtime";',
  'import { useAction, useActionSpent } from "@ggui-ai/wire";',
  'export default function GuardedSaveCard() {',
  '  const save = useAction("save");',
  '  const saveSpent = useActionSpent("save");',
  '  return jsx("button", {',
  '    type: "button",',
  '    disabled: saveSpent,',
  '    onClick: () => save({}),',
  '    children: "Save",',
  '  });',
  '}',
  '',
].join('\n');

/** Register the card's bytes, render it through the cache, and mount it in a browser. */
async function mountFixedCard(
  contract: ReturnType<typeof saveContract>,
  componentCode: string,
  intent: string,
): Promise<{ host: McpAppHostHandle; browser: BrowserHandle }> {
  unwrapStructured<{ codeHash: string }>(
    await callTool(CONTROL_URL, 'ggui_ops_register_blueprint', {
      contract,
      componentCode,
      confirm: true,
    }),
  );
  const handshake = unwrapStructured<{ handshakeId: string; suggestion: { origin: string } }>(
    await callTool(MCP_URL, 'ggui_handshake', { intent, blueprintDraft: { contract } }),
  );
  expect(handshake.suggestion.origin, 'the fixed card must be served from the cache, not generated').toBe(
    'cache',
  );
  const render = unwrapStructured<{ resourceUri: string }>(
    await callTool(MCP_URL, 'ggui_render', { handshakeId: handshake.handshakeId, props: {} }),
  );
  const host = await mountRenderResource({ mcpUrl: MCP_URL, resourceUri: render.resourceUri });
  const browser = await openBrowser();
  await browser.page.goto(host.url, { waitUntil: 'domcontentloaded' });
  return { host, browser };
}

describe('Scenario 29 — the repeatable-control check on fixed cards (ggui#1398)', () => {
  let host: McpAppHostHandle | null = null;
  let browser: BrowserHandle | null = null;
  afterEach(async () => {
    await browser?.close();
    browser = null;
    await host?.close();
    host = null;
  });

  test(
    'a control that goes pending is observed pending, and the check passes once it recovers',
    async () => {
      ({ host, browser } = await mountFixedCard(
        PENDING_CONTRACT,
        PENDING_CARD,
        'a save button that shows it is working — scenario 29',
      ));
      const frame = browser.page.frameLocator(MCP_APP_IFRAME_SELECTOR);
      const buttons = frame.getByRole('button', { name: /save/i });
      await buttons.first().waitFor({ state: 'visible', timeout: 30_000 });
      await buttons.first().click();

      // The branch under test actually ran: the tapped control is pending.
      const pending = frame.locator('button[aria-busy="true"]');
      await expect
        .poll(async () => (await pending.count()) > 0 && (await pending.first().innerText()).trim(), {
          timeout: 5_000,
        })
        .toBe('Saving…');

      await expectSaveStillRepeatable(frame, buttons);
    },
    90_000,
  );

  test(
    'a control that guards itself for good is rejected by the check',
    async () => {
      ({ host, browser } = await mountFixedCard(
        GUARDED_CONTRACT,
        GUARDED_CARD,
        'a save button that locks after one press — scenario 29',
      ));
      const frame = browser.page.frameLocator(MCP_APP_IFRAME_SELECTOR);
      const buttons = frame.getByRole('button', { name: /save/i });
      await buttons.first().waitFor({ state: 'visible', timeout: 30_000 });
      await buttons.first().click();

      await expect(expectSaveStillRepeatable(frame, buttons)).rejects.toThrow(/was guarded after firing/);
    },
    90_000,
  );
});
