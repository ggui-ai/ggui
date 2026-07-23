/**
 * Tier 2 failure envelope: prove the host simulator surfaces the
 * first-class `ggui_render` failure envelope end-to-end through a
 * real OSS server AND the real MCP SDK client.
 *
 * What this asserts (pinned failure-envelope contract):
 *   1. A failed generation returns an `isError: true` TOOL RESULT
 *      (in-result — not a thrown/JSON-RPC error), and the simulator's
 *      `render()`/`openRender()` helpers propagate the flag verbatim
 *      so scenario authors can branch on `render.isError`.
 *   2. `structuredContent` stays SCHEMA-CONFORMANT on failure — the
 *      MCP SDK client validates it against the tool's outputSchema
 *      even when `isError` is set, so this test passing at all proves
 *      the envelope validates. It carries the committed error render's
 *      `sessionId`, the canonical `error: {code, message}`, a
 *      `cache.hit: false` marker, and NO `resourceUri` (the render is
 *      not mountable).
 *   3. NO `_meta` rides on the failure — `render.meta` is absent, so a
 *      host has no `ai.ggui/render` slice and mounts nothing.
 *   4. `content[0].text` is the model-visible self-correction surface
 *      in the pinned `<CODE>: <message>. Do not call ggui_render
 *      again…` format.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HostSimulator, bootOssServer, type OssFixture } from '../src/index.js';

/** Structural mirror of the failure slice of `renderOutputSchema`. */
interface FailureStructured {
  readonly sessionId?: string;
  readonly resourceUri?: string;
  readonly blueprintId?: string;
  readonly cache?: { readonly hit?: boolean };
  readonly error?: { readonly code?: string; readonly message?: string };
}

describe('host-simulator: ggui_render failure envelope against OSS createGguiServer', () => {
  let fixture: OssFixture | null = null;
  let host: HostSimulator | null = null;

  afterEach(async () => {
    if (host) {
      await host.close();
      host = null;
    }
    if (fixture) {
      await fixture.close();
      fixture = null;
    }
  });

  it('failed generation → isError result with schema-conformant structuredContent, error code, and NO meta', async () => {
    fixture = await bootOssServer({
      generation: {
        // Deterministic failing generator — every cold gen reports a
        // production failure, driving the handler down the
        // `handlerFailure` (in-result failure envelope) path.
        uiGenerator: {
          slug: 'ui-gen-default-haiku-4-5',
          tier: 'default',
          model: 'claude-haiku-4-5-20251001',
          generate: async () => ({
            ok: false as const,
            error: {
              code: 'PRODUCTION_FAILED' as const,
              message: 'forced generation failure (host-simulator test)',
            },
          }),
        },
        // Credentials resolve fine — the failure under test is the
        // generator's, not a NO_CREDENTIALS seam reject.
        resolveLlm: () => ({
          selection: {
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
          },
          providerKey: { provider: 'anthropic', key: 'test-key-unused' },
        }),
        blueprints: { list: async () => [], get: async () => null },
      },
    });
    host = new HostSimulator({
      url: fixture.url,
      bearer: 'host-simulator-test',
    });
    await host.connect();

    const flow = await host.openRender({
      intent: 'render a card that will fail to generate',
      blueprintDraft: {
        contract: {
          contextSpec: {
            greeting: { schema: { type: 'string' }, default: 'hello' },
          },
        },
      },
      forceCreate: true,
    });

    // 1. In-result isError propagates through the SDK client + the
    //    simulator's render()/openRender() helpers verbatim.
    expect(flow.render.isError, 'failure envelope must set isError').toBe(
      true,
    );

    // 2. Schema-conformant structuredContent with the canonical error.
    //    (The MCP SDK client already validated it against the tool's
    //    outputSchema — reaching this line proves conformance.)
    const structured = flow.render.structuredContent as FailureStructured;
    expect(structured.error?.code).toBe('PRODUCTION_FAILED');
    expect(structured.error?.message).toContain(
      'forced generation failure',
    );
    // The error GguiSession IS committed — sessionId names it.
    expect(structured.sessionId?.length ?? 0).toBeGreaterThan(0);
    // Not mountable: no resourceUri; no materialised blueprint.
    expect(structured.resourceUri).toBeUndefined();
    expect(structured.blueprintId).toBe('');
    expect(structured.cache?.hit).toBe(false);

    // 3. NO _meta on failures — nothing to mount, no bootstrap slice.
    expect(
      flow.render.meta,
      'failure envelope must carry no ai.ggui/render meta',
    ).toBeUndefined();

    // 4. Model-visible self-correction text in the pinned format.
    const firstBlock = flow.render.content[0] as
      | { type?: string; text?: string }
      | undefined;
    expect(firstBlock?.text ?? '').toMatch(/^PRODUCTION_FAILED: /);
    expect(firstBlock?.text ?? '').toContain(
      'Do not call ggui_render again with this handshakeId — it is consumed.',
    );
    expect(firstBlock?.text ?? '').toContain(
      'call ggui_handshake again once resolved.',
    );
  });
});
