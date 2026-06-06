/**
 * Scenario 5 — pure-display render (no actionSpec) emits NO `nextStep`.
 *
 * Agent contract:
 *   - Contracts WITH `actionSpec` → render response includes
 *     `nextStep: {tool:'ggui_consume', args:{sessionId}}` so the
 *     agent long-polls for user gestures.
 *   - Contracts WITHOUT `actionSpec` → no `nextStep`. Agent ends its
 *     turn cleanly; the user reads the UI and prompts when ready.
 *
 * Server-side only (no browser). Render still triggers generation, so
 * the scenario is gated on `ANTHROPIC_API_KEY`.
 */
import { describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';

const MCP_URL = `http://localhost:${process.env.GGUI_PORT ?? 6781}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_KEY)('Scenario 5 — pure-display render (no actionSpec)', () => {
  test('render response omits nextStep when contract has no actionSpec', async () => {
    const handshake = unwrapStructured<{ handshakeId: string }>(
      await callTool(MCP_URL, 'ggui_handshake', {
        intent: 'show a static welcome banner',
        blueprintDraft: {
          contract: {
            propsSpec: {
              description: 'welcome banner props',
              properties: {
                title: {
                  schema: { type: 'string' },
                  required: true,
                  description: 'banner heading',
                },
              },
            },
            // No actionSpec — purely display.
          },
        },
      }),
    );

    const render = unwrapStructured<{
      sessionId: string;
      nextStep?: { tool?: string };
    }>(
      await callTool(MCP_URL, 'ggui_render', {
        handshakeId: handshake.handshakeId,
        props: { title: 'Welcome to ggui' },
      }),
    );

    expect(render.sessionId).toBeTruthy();
    // Pure display = no consume loop = no nextStep.
    expect(render.nextStep).toBeUndefined();
  }, 90_000);
});
