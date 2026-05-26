/**
 * Tier 2 happy-path: prove the host simulator drives a real OSS
 * server through the full App-spec lifecycle without a browser.
 *
 * What this asserts:
 *   1. `tools/list` discovers `ggui_push` AND surfaces its declared
 *      `_meta.ui.resourceUri` (`ui://ggui/session`). The host pre-
 *      fetches it.
 *   2. The pre-fetched resource body is non-empty (the iframe shell
 *      HTML lives on this URI per `mcp-apps-outbound.ts`).
 *   3. `ggui_push` returns `_meta.ggui.bootstrap` carrying the WS
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

  it('discovers ggui_push, pre-fetches resourceUri, mints bootstrap, ws ack', async () => {
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
    const push = tools.find((t) => t.name === 'ggui_push');
    expect(push, 'ggui_push must be in tools/list').toBeDefined();
    expect(
      push?.resourceUri,
      'ggui_push must declare _meta.ui.resourceUri = ui://ggui/session',
    ).toBe('ui://ggui/session');

    // 2. Pre-fetched resource is non-empty (the iframe shell HTML).
    const shell = host.getPrefetchedResource('ui://ggui/session');
    expect(shell, 'shell HTML body must be non-empty').toBeTruthy();
    expect(shell?.length ?? 0).toBeGreaterThan(100);

    // 3. new_session → handshake → push (canonical three-step D10 flow).
    //
    // Post-MVB-5: agent posts a `blueprintDraft` on handshake, the
    // server returns a `suggestion` with `origin: cache|agent|synth`,
    // and the simulator accepts the suggestion verbatim on push.
    const flow = await host.openSession({
      intent: 'render a hello world card',
      seed: 'host-simulator-happy-path',
      blueprintDraft: {
        contract: {
          contextSpec: {
            greeting: { schema: { type: 'string' }, default: 'hello' },
          },
        },
      },
    });
    expect(flow.push.meta, '_meta ai.ggui slices must be set').toBeDefined();
    expect(flow.push.meta?.session?.wsUrl).toMatch(/^ws:\/\//);
    expect(flow.push.meta?.session?.wsToken).toBeTruthy();
    // OSS factory mints bare UUID; pod-side prefixes `sess_` (different
    // convention). Assert non-empty rather than format-specific.
    expect(flow.push.meta?.session?.sessionId.length ?? 0).toBeGreaterThan(0);

    // 4. WS subscribe → ack.
    const { ack } = await host.subscribeWith(flow.push.meta!);
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
