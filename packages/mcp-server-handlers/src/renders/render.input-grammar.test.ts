import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createGguiRenderHandler } from './render.js';

const CTX: HandlerContext = { appId: 'app-grammar', requestId: 'r-grammar' };

describe('ggui_render — the infra.model grammar precedes the pre-generation gate (#818)', () => {
  it('a route that parses in neither wire form fails the handler input parse at infra.model and never reaches the gate', async () => {
    const gate = vi.fn(async () => undefined);
    const handler = createGguiRenderHandler({
      renderStore: new InMemoryGguiSessionStore(),
      preValidationGate: gate,
    });
    await expect(
      handler.handler({ handshakeId: 'hs_1', props: {}, infra: { model: 'claude-haiku-4-5' } }, CTX),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ path: ['infra', 'model'] })] });
    expect(gate).not.toHaveBeenCalled();
  });

  it('a well-formed route reaches the gate', async () => {
    const gate = vi.fn(async () => undefined);
    const handler = createGguiRenderHandler({
      renderStore: new InMemoryGguiSessionStore(),
      preValidationGate: gate,
    });
    // Downstream fails (no handshake record) — the gate call is the assertion.
    await handler
      .handler({ handshakeId: 'hs_1', props: {}, infra: { model: 'anthropic:claude-haiku-4-5' } }, CTX)
      .catch(() => undefined);
    expect(gate).toHaveBeenCalledTimes(1);
  });
});
