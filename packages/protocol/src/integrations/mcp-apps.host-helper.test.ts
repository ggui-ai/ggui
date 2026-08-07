/**
 * Host-helper surface — the `_meta["ai.ggui/render"]` narrowing +
 * self-contained-shell construction MCP-Apps hosts consume instead of
 * carrying their own copies of ggui's mount contract.
 *
 * The load-bearing property under test is the VERBATIM posture:
 * `asGguiRenderBootstrap` is a mountability gate, not a validator — it
 * proves the slice has enough to mount (`runtimeUrl` + one mode
 * discriminator) and carries every other field through untouched, so a
 * host built against today's protocol passes a newer server's fields
 * through to a newer runtime without stripping them. The strict
 * projecting parser (`parseMcpAppAiGguiRenderMeta`) is deliberately NOT
 * in this path.
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  asGguiRenderBootstrap,
  gguiShellHtml,
  toolResultGguiRender,
} from './mcp-apps.js';

const LIVE_SLICE = {
  sessionId: 'render_0001',
  appId: 'APP00000',
  runtimeUrl: 'https://mcp.example.dev/_ggui/iframe-runtime.js',
  wsUrl: 'wss://mcp.example.dev/ws',
  wsToken: 'tok_1',
  expiresAt: '2099-01-01T00:00:00.000Z',
  propsJson: '{"title":"Groceries"}',
};

function envelope(
  slice: Record<string, unknown>,
): Record<string, unknown> {
  return { [MCP_APP_AI_GGUI_RENDER_META_KEY]: slice };
}

/** Extract + parse the inlined `__GGUI_META__` JSON back out of a shell. */
function inlinedEnvelope(html: string): unknown {
  const match = html.match(
    /globalThis\.__GGUI_META__ = (.*);<\/script>/,
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1]);
}

describe('asGguiRenderBootstrap', () => {
  it('returns undefined for non-object meta', () => {
    expect(asGguiRenderBootstrap(undefined)).toBeUndefined();
    expect(asGguiRenderBootstrap(null)).toBeUndefined();
    expect(asGguiRenderBootstrap('x')).toBeUndefined();
    expect(asGguiRenderBootstrap(42)).toBeUndefined();
    expect(asGguiRenderBootstrap([])).toBeUndefined();
  });

  it('returns undefined when the envelope key is absent', () => {
    expect(asGguiRenderBootstrap({ 'ai.ggui/other': {} })).toBeUndefined();
  });

  it('returns undefined when the slice is not an object', () => {
    expect(
      asGguiRenderBootstrap(envelope('nope' as unknown as Record<string, unknown>)),
    ).toBeUndefined();
  });

  it('returns undefined without a non-empty runtimeUrl', () => {
    const { runtimeUrl: _dropped, ...rest } = LIVE_SLICE;
    expect(asGguiRenderBootstrap(envelope(rest))).toBeUndefined();
    expect(
      asGguiRenderBootstrap(envelope({ ...LIVE_SLICE, runtimeUrl: '' })),
    ).toBeUndefined();
  });

  it('returns undefined without a mode discriminator (runtimeUrl alone mounts nothing)', () => {
    expect(
      asGguiRenderBootstrap(
        envelope({
          sessionId: 'render_0001',
          appId: 'APP00000',
          runtimeUrl: LIVE_SLICE.runtimeUrl,
        }),
      ),
    ).toBeUndefined();
  });

  it('rejects half-live (wsUrl without wsToken) as no discriminator', () => {
    const { wsToken: _dropped, ...halfLive } = LIVE_SLICE;
    expect(asGguiRenderBootstrap(envelope(halfLive))).toBeUndefined();
  });

  it('accepts live mode and surfaces runtimeUrl', () => {
    const bootstrap = asGguiRenderBootstrap(envelope(LIVE_SLICE));
    expect(bootstrap).toBeDefined();
    expect(bootstrap!.runtimeUrl).toBe(LIVE_SLICE.runtimeUrl);
    expect(bootstrap!.slice).toEqual(LIVE_SLICE);
  });

  it('accepts static-component mode (codeUrl)', () => {
    const slice = {
      sessionId: 'render_0002',
      appId: 'APP00000',
      runtimeUrl: LIVE_SLICE.runtimeUrl,
      codeUrl: 'https://mcp.example.dev/code/abc.js',
    };
    expect(asGguiRenderBootstrap(envelope(slice))?.slice).toEqual(slice);
  });

  it('accepts system-card mode (kind)', () => {
    const slice = {
      sessionId: 'render_0003',
      appId: 'APP00000',
      runtimeUrl: LIVE_SLICE.runtimeUrl,
      kind: 'auth-required',
    };
    expect(asGguiRenderBootstrap(envelope(slice))?.slice).toEqual(slice);
  });

  it('carries unknown future fields through verbatim', () => {
    const slice = {
      ...LIVE_SLICE,
      futureField: { nested: true, list: [1, 2] },
    };
    const bootstrap = asGguiRenderBootstrap(envelope(slice));
    expect(bootstrap!.slice).toEqual(slice);
  });
});

describe('toolResultGguiRender', () => {
  it('returns undefined for non-object results and results without _meta', () => {
    expect(toolResultGguiRender(undefined)).toBeUndefined();
    expect(toolResultGguiRender('x')).toBeUndefined();
    expect(toolResultGguiRender({ content: [] })).toBeUndefined();
    expect(toolResultGguiRender({ content: [], _meta: {} })).toBeUndefined();
  });

  it('narrows a spec-canonical CallToolResult (top-level _meta)', () => {
    const result = { content: [], _meta: envelope(LIVE_SLICE) };
    const bootstrap = toolResultGguiRender(result);
    expect(bootstrap?.runtimeUrl).toBe(LIVE_SLICE.runtimeUrl);
    expect(bootstrap?.slice).toEqual(LIVE_SLICE);
  });
});

describe('gguiShellHtml', () => {
  const bootstrap = asGguiRenderBootstrap(envelope(LIVE_SLICE))!;

  it('inlines the verbatim envelope on globalThis.__GGUI_META__', () => {
    const withFuture = asGguiRenderBootstrap(
      envelope({ ...LIVE_SLICE, futureField: 'ride-along' }),
    )!;
    const parsed = inlinedEnvelope(gguiShellHtml(withFuture));
    expect(parsed).toEqual(
      envelope({ ...LIVE_SLICE, futureField: 'ride-along' }),
    );
  });

  it('loads the runtime via a deferred ES-module script with CORS error reporting', () => {
    const html = gguiShellHtml(bootstrap);
    expect(html).toContain(
      `<script type="module" crossorigin="anonymous" src="${LIVE_SLICE.runtimeUrl}"></script>`,
    );
  });

  it('inlines the meta global BEFORE the module script (parse-order guarantee)', () => {
    const html = gguiShellHtml(bootstrap);
    const metaAt = html.indexOf('__GGUI_META__');
    const moduleAt = html.indexOf('<script type="module"');
    expect(metaAt).toBeGreaterThan(-1);
    expect(moduleAt).toBeGreaterThan(metaAt);
  });

  it('HTML-escapes the runtimeUrl attribute', () => {
    const hostile = asGguiRenderBootstrap(
      envelope({
        ...LIVE_SLICE,
        runtimeUrl: 'https://mcp.example.dev/r.js?a=1&b="x"',
      }),
    )!;
    const html = gguiShellHtml(hostile);
    expect(html).toContain('src="https://mcp.example.dev/r.js?a=1&amp;b=&quot;x&quot;"');
  });

  it('cannot be broken out of by a </script> sequence inside a slice string', () => {
    const hostile = asGguiRenderBootstrap(
      envelope({
        ...LIVE_SLICE,
        propsJson: '{"x":"</script><script>alert(1)</script>"}',
      }),
    )!;
    const html = gguiShellHtml(hostile);
    expect(html).not.toContain('</script><script>alert(1)');
    // The escaped JSON still round-trips to the exact same value.
    const parsed = inlinedEnvelope(html) as Record<string, Record<string, unknown>>;
    expect(parsed[MCP_APP_AI_GGUI_RENDER_META_KEY].propsJson).toBe(
      '{"x":"</script><script>alert(1)</script>"}',
    );
  });

  it('escapes U+2028/U+2029 JS line terminators', () => {
    const hostile = asGguiRenderBootstrap(
      envelope({ ...LIVE_SLICE, propsJson: '{"x":"a b c"}' }),
    )!;
    const html = gguiShellHtml(hostile);
    expect(html).not.toContain(' ');
    expect(html).not.toContain(' ');
    const parsed = inlinedEnvelope(html) as Record<string, Record<string, unknown>>;
    expect(parsed[MCP_APP_AI_GGUI_RENDER_META_KEY].propsJson).toBe(
      '{"x":"a b c"}',
    );
  });

  it('paints the theme surface backdrop by default (served-document posture)', () => {
    const html = gguiShellHtml(bootstrap);
    expect(html).toContain('var(--ggui-color-surface');
    expect(html).not.toContain('background:transparent');
  });

  it('supports the transparent backdrop for host-embedded cards', () => {
    const html = gguiShellHtml(bootstrap, { background: 'transparent' });
    expect(html).toContain('background:transparent');
    expect(html).not.toContain('var(--ggui-color-surface');
  });

  it('declares viewport + color-scheme metas (mobile WebView hosts)', () => {
    const html = gguiShellHtml(bootstrap);
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="color-scheme"');
  });
});
