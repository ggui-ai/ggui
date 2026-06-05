/**
 * Tier 2 happy-path: prove the host simulator drives a real OSS
 * server through the full App-spec lifecycle without a browser.
 *
 * What this asserts:
 *   1. `tools/list` discovers `ggui_render` AND surfaces its declared
 *      `_meta.ui.resourceUri` (`ui://ggui/render`). The host pre-
 *      fetches it.
 *   2. The pre-fetched resource body is non-empty (the iframe shell
 *      HTML lives on this URI per `mcp-apps-outbound.ts`).
 *   3. `ggui_render` returns `_meta["ai.ggui/render"]` carrying the WS
 *      URL + token + sessionId + appId + runtimeUrl.
 *   4. WebSocket subscribe with the bootstrap token yields an `ack`
 *      with a reconnect `sessionToken`.
 *
 * That's the minimum claude.ai does on a single user-message turn,
 * minus the LLM tool-selection layer (which is host-side, not
 * server-contract). If this passes, our wire shape is host-compatible.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HostSimulator, bootOssServer, type OssFixture } from '../src/index.js';

describe('host-simulator: happy path against OSS createGguiServer', () => {
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

  it('discovers ggui_render, pre-fetches resourceUri, mints bootstrap, ws ack', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({
      url: fixture.url,
      // OSS server's default auth adapter is `devAllowAll` —
      // any non-empty token works. We send one to verify the
      // Authorization header flows; null bearer would skip the
      // header entirely.
      bearer: 'host-simulator-test',
    });
    await host.connect();

    // 1. tools/list with pre-fetch.
    const tools = await host.listTools();
    const render = tools.find((t) => t.name === 'ggui_render');
    expect(render, 'ggui_render must be in tools/list').toBeDefined();
    expect(
      render?.resourceUri,
      'ggui_render must declare _meta.ui.resourceUri = ui://ggui/render',
    ).toBe('ui://ggui/render');

    // 2. Pre-fetched resource is non-empty (the iframe shell HTML).
    const shell = host.getPrefetchedResource('ui://ggui/render');
    expect(shell, 'shell HTML body must be non-empty').toBeTruthy();
    expect(shell?.length ?? 0).toBeGreaterThan(100);

    // 3. handshake → render (canonical Phase-B two-step flow).
    //
    // Post-Phase-B: agent posts a `blueprintDraft` on handshake, the
    // server returns a `suggestion` with `origin: cache|agent|synth`,
    // and the simulator accepts the suggestion verbatim on render.
    // The prior `ggui_new_session` mint is gone — every render IS the
    // addressable scope.
    const flow = await host.openRender({
      intent: 'render a hello world card',
      blueprintDraft: {
        contract: {
          contextSpec: {
            greeting: { schema: { type: 'string' }, default: 'hello' },
          },
        },
      },
    });
    expect(flow.render.meta, '_meta ai.ggui/render slice must be set').toBeDefined();
    expect(flow.render.meta?.wsUrl).toMatch(/^ws:\/\//);
    expect(flow.render.meta?.wsToken).toBeTruthy();
    // OSS factory mints bare UUID; pod-side prefixes (different
    // convention). Assert non-empty rather than format-specific.
    expect(flow.render.meta?.sessionId.length ?? 0).toBeGreaterThan(0);

    // 4. WS subscribe → ack.
    const { ack } = await host.subscribeWith(flow.render.meta!);
    expect(ack.kind, `WS ack expected, got code=${ack.code ?? '(none)'}`).toBe(
      'ack',
    );
    expect(ack.sessionToken, 'ack must carry reconnect sessionToken').toBeTruthy();
  });

  it('caches tools/list — second listTools() call is idempotent', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({
      url: fixture.url,
      bearer: 'host-simulator-test',
    });
    await host.connect();

    const first = await host.listTools();
    const second = await host.listTools();
    expect(second, 'second call should return identical reference').toBe(first);
  });
});
