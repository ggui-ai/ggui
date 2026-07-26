/**
 * Transport-tolerance pin for `ggui_update` unknown keys (ggui#385).
 *
 * `@ggui-ai/protocol`'s `updateInputSchema` is strict — unknown keys
 * reject — and the handler's own parse is strict too. But the MCP SDK's
 * tool-arg validation (`validateToolInput` → `safeParseAsync` over a
 * non-strict object built from the registered raw shape) STRIPS unknown
 * keys before any ggui handler runs. So the observable WIRE behavior is
 * tolerant-reader: a call carrying an unknown key proceeds exactly as if
 * the key were never sent.
 *
 * This file pins that tolerance — it is a documentation of transport
 * behavior, not an endorsement of it. If it starts failing, one of two
 * deliberate things happened and `update.ts`'s header tolerance note
 * must be updated in the same commit:
 *   - the pinned MCP SDK changed its arg validation to strict, or
 *   - ggui moved tool registration from a `ZodRawShape` to a full
 *     (strict/union) schema.
 * Either way the wire would then reject unknown keys, matching protocol
 * end-to-end, and the tolerance note (plus this pin) should be deleted.
 *
 * Deliberately asserts EQUIVALENCE with a control call rather than a
 * specific error string: the probe target is "the unknown key changed
 * nothing", which stays valid however the not-found wording evolves.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HostSimulator, bootOssServer, type OssFixture } from '../src/index.js';

describe('ggui_update unknown-key transport tolerance (ggui#385)', () => {
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

  it('an unknown key on ggui_update is stripped by the SDK, not rejected', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({ url: fixture.url });
    await host.connect();

    const withExtra = await host.callTool('ggui_update', {
      sessionId: 'render_does_not_exist',
      kind: 'merge',
      patch: {},
      UNKNOWN_EXTRA_KEY: 'protocol-strict-would-reject-this',
    });
    const control = await host.callTool('ggui_update', {
      sessionId: 'render_does_not_exist',
      kind: 'merge',
      patch: {},
    });

    // Both reach the handler and die on session-not-found — the extra
    // key changes nothing. A strict transport would instead fail the
    // withExtra call at arg validation (InvalidParams / "Input
    // validation error"), before the handler ever ran.
    expect(withExtra.isError ?? false).toBe(true);
    expect(control.isError ?? false).toBe(true);
    expect(JSON.stringify(withExtra.content)).toBe(
      JSON.stringify(control.content),
    );
    expect(JSON.stringify(withExtra.content)).not.toContain(
      'Input validation error',
    );
  });
});
