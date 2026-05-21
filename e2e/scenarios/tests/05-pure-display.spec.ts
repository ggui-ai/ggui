/**
 * Scenario 5 — pure-display push (no actionSpec) emits NO `nextStep`.
 *
 * Agent contract:
 *   - Contracts WITH `actionSpec` → push response includes
 *     `nextStep: {tool:'ggui_consume', args:{stackItemId}}` so the
 *     agent long-polls for user gestures.
 *   - Contracts WITHOUT `actionSpec` → no `nextStep`. Agent ends its
 *     turn cleanly; the user reads the UI and prompts when ready.
 *
 * Server-side only (no browser). Push still triggers generation, so
 * the scenario is gated on `ANTHROPIC_API_KEY`.
 */
import { describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';

const MCP_URL = `http://localhost:${process.env.GGUI_PORT ?? 6781}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_KEY)('Scenario 5 — pure-display push (no actionSpec)', () => {
  test('push response omits nextStep when contract has no actionSpec', async () => {
    const session = unwrapStructured<{ sessionId: string }>(
      await callTool(MCP_URL, 'ggui_new_session', { seed: 'scenario-5' }),
    );

    const handshake = unwrapStructured<{ handshakeId: string }>(
      await callTool(MCP_URL, 'ggui_handshake', {
        sessionId: session.sessionId,
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

    const push = unwrapStructured<{
      stackItemId: string;
      nextStep?: { tool?: string };
    }>(
      await callTool(MCP_URL, 'ggui_push', {
        handshakeId: handshake.handshakeId,
        decision: { kind: 'accept' },
        props: { title: 'Welcome to ggui' },
      }),
    );

    expect(push.stackItemId).toBeTruthy();
    // Pure display = no consume loop = no nextStep.
    expect(push.nextStep).toBeUndefined();
  }, 90_000);
});
