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
  escapeInlineScript,
  gguiShellHtml,
  readGguiShellEnvelope,
  parseMcpAppAiGguiRenderMeta,
  toolResultGguiRender,
  GGUI_RENDER_SHELL_SURFACE,
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

/**
 * Extract + parse the inlined `__GGUI_META__` JSON back out of a shell —
 * through the protocol's own inverse, so these tests pin writer/reader
 * PARITY (the read-plane door, ggui#537, reads shells exactly this way).
 */
function inlinedEnvelope(html: string): unknown {
  const parsed = readGguiShellEnvelope(html);
  expect(parsed).toBeDefined();
  return parsed;
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
      kind: 'no-credentials',
    };
    expect(asGguiRenderBootstrap(envelope(slice))?.slice).toEqual(slice);
  });

  it('accepts inline static-component mode (codeB64) as a mount discriminator', () => {
    const slice = {
      sessionId: 'render_0004',
      appId: 'APP00000',
      runtimeUrl: LIVE_SLICE.runtimeUrl,
      codeB64: Buffer.from('export default () => null').toString('base64'),
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

  it('surface backdrop opens with the runtime override point (ggui#514)', () => {
    // The backdrop is an INLINE style, so no stylesheet `background`
    // rule can out-cascade it — the `--ggui-shell-background` head of
    // the var() chain is the only seam through which the card layer
    // (ThemeProvider's transparent posture) can drop it. Removing the
    // head silently re-breaks system-card transparency in compositing
    // hosts.
    const html = gguiShellHtml(bootstrap);
    expect(html).toContain(
      'var(--ggui-shell-background, var(--ggui-color-surface',
    );
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

  // ── #662: scheme-aware pre-render placeholder ─────────────────────────
  //
  // Before the runtime injects theme vars, the shell's surface chain
  // bottoms out at its terminal fallback — which used to be a single
  // dark constant that painted an indigo-dark slab on light hosts
  // while components loaded. The terminal fallback is now a
  // scheme-scoped variable the shell's own <style> sets per
  // prefers-color-scheme: neutral light ground on light, neutral dark
  // ground on dark. Theme still wins post-inject (--ggui-color-surface
  // outranks it) and --ggui-shell-background stays the top override.
  it('paints a scheme-aware neutral placeholder ground (#662)', () => {
    const html = gguiShellHtml(bootstrap);
    // The scheme style block ships in <head>, before first paint.
    expect(html).toContain('data-ggui-shell-scheme');
    expect(html).toContain('--ggui-shell-scheme-surface:#f9fafb');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('--ggui-shell-scheme-surface:#111827');
    // The surface chain terminates in the scheme var, not a bare dark
    // constant — precedence: override > theme > scheme fallback.
    expect(GGUI_RENDER_SHELL_SURFACE).toBe(
      'var(--ggui-shell-background, var(--ggui-color-surface, var(--ggui-shell-scheme-surface, #f9fafb)))',
    );
    expect(html).not.toContain('#1e293b');
  });

  it('runtimeInlineSource swaps the external tag for an inline module script', () => {
    const html = gguiShellHtml(bootstrap, {
      runtimeInlineSource: 'globalThis.__ran = 1;',
    });
    expect(html).toContain(
      '<script type="module" data-ggui-runtime="inline">globalThis.__ran = 1;</script>',
    );
    expect(html).not.toContain(`src="${LIVE_SLICE.runtimeUrl}"`);
    // Meta global still inlined first — parse-order guarantee holds in
    // the inline variant too.
    const metaAt = html.indexOf('__GGUI_META__');
    const moduleAt = html.indexOf('<script type="module"');
    expect(metaAt).toBeGreaterThan(-1);
    expect(moduleAt).toBeGreaterThan(metaAt);
    // The inlined meta still carries runtimeUrl (boot validator
    // requires it across all modes).
    const parsed = inlinedEnvelope(html) as Record<string, Record<string, unknown>>;
    expect(parsed[MCP_APP_AI_GGUI_RENDER_META_KEY].runtimeUrl).toBe(
      LIVE_SLICE.runtimeUrl,
    );
  });

  it('runtimeInlineSource escapes script-terminating sequences in the bundle text', () => {
    const html = gguiShellHtml(bootstrap, {
      runtimeInlineSource: 'const a = "</script>"; const b = "<!--";',
    });
    expect(html).not.toContain('const a = "</script>"');
    expect(html).toContain('const a = "<\\/script>"');
    expect(html).toContain('const b = "<\\!--"');
  });
});

describe('escapeInlineScript', () => {
  it('neutralizes </script case-insensitively, preserving original casing', () => {
    expect(escapeInlineScript('x="</script>"')).toBe('x="<\\/script>"');
    expect(escapeInlineScript('x="</SCRIPT>"')).toBe('x="<\\/SCRIPT>"');
    expect(escapeInlineScript('x="</ScRiPt>"')).toBe('x="<\\/ScRiPt>"');
  });

  it('neutralizes <!-- sequences', () => {
    expect(escapeInlineScript('re=/<!--/')).toBe('re=/<\\!--/');
  });

  it('escaped output evaluates identically for string-literal occurrences', () => {
    const src = 'globalThis.__esc = "</script>" + "<!--";';
    const escaped = escapeInlineScript(src);
    // `\/` and `\!` are identity escapes inside JS string literals.
    // eslint-disable-next-line no-new-func
    new Function(escaped)();
    expect(
      (globalThis as Record<string, unknown>).__esc,
    ).toBe('</script><!--');
    delete (globalThis as Record<string, unknown>).__esc;
  });

  it('leaves already-escaped sequences untouched', () => {
    expect(escapeInlineScript('x="<\\/script>"')).toBe('x="<\\/script>"');
  });
});

describe('parseMcpAppAiGguiRenderMeta — codeB64', () => {
  const base = {
    sessionId: 'render_0005',
    appId: 'APP00000',
    runtimeUrl: LIVE_SLICE.runtimeUrl,
  };

  it('carries codeB64 through, alone or alongside codeUrl', () => {
    const alone = parseMcpAppAiGguiRenderMeta(
      envelope({ ...base, codeB64: 'ZXhwb3J0' }),
    );
    expect(alone.ok && alone.meta?.codeB64).toBe('ZXhwb3J0');
    const both = parseMcpAppAiGguiRenderMeta(
      envelope({ ...base, codeB64: 'ZXhwb3J0', codeUrl: 'https://x/code/a.js' }),
    );
    expect(both.ok && both.meta?.codeB64).toBe('ZXhwb3J0');
    expect(both.ok && both.meta?.codeUrl).toBe('https://x/code/a.js');
  });

  it('rejects codeB64 + kind (static-component vs system-card exclusivity)', () => {
    const result = parseMcpAppAiGguiRenderMeta(
      envelope({ ...base, codeB64: 'ZXhwb3J0', kind: 'no-credentials' }),
    );
    expect(result).toEqual({ ok: false, reason: 'MALFORMED_RENDER' });
  });

  it('rejects an empty codeB64', () => {
    const result = parseMcpAppAiGguiRenderMeta(
      envelope({ ...base, codeB64: '', wsUrl: 'w', wsToken: 't' }),
    );
    expect(result).toEqual({ ok: false, reason: 'MALFORMED_RENDER' });
  });
});

describe('readGguiShellEnvelope (the read-plane door reader)', () => {
  it('round-trips gguiShellHtml, including a slice string that carries a script terminator', () => {
    const slice = { ...LIVE_SLICE, propsJson: '{"t":"</script><script>alert(1)</script>"}' };
    const bootstrap = asGguiRenderBootstrap(envelope(slice));
    expect(bootstrap).toBeDefined();
    expect(readGguiShellEnvelope(gguiShellHtml(bootstrap!))).toEqual(envelope(slice));
  });

  it('returns undefined for a document without the marker (a thin static shell, a failure page)', () => {
    expect(readGguiShellEnvelope('<!doctype html><html><body>Waiting for tool result…</body></html>')).toBeUndefined();
    expect(readGguiShellEnvelope('')).toBeUndefined();
  });

  it('returns undefined when the JSON does not parse (truncated body) — never throws', () => {
    const bootstrap = asGguiRenderBootstrap(envelope(LIVE_SLICE));
    expect(bootstrap).toBeDefined();
    const html = gguiShellHtml(bootstrap!);
    const cut = html.slice(0, html.indexOf('"wsUrl"') + 5);
    expect(readGguiShellEnvelope(cut)).toBeUndefined();
  });
});
