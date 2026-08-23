/**
 * Runtime self-identification reports the SHIPPED wave (ggui#622).
 *
 * Two surfaces told every connected agent a hand-typed lie for four
 * waves: MCP `serverInfo.version` said `0.0.1` and the inline shell's
 * MCP Apps `appInfo.version` said `1.0.0` while npm served 0.11.0.
 * Both now read `GGUI_WAVE_VERSION` (ggui#623), which is itself
 * parity-pinned to `@ggui-ai/protocol`'s package.json — so the wire
 * identity cannot drift from the published cohort.
 */
import { describe, expect, it } from 'vitest';
import { GGUI_WAVE_VERSION } from '@ggui-ai/protocol';
import { DEFAULT_INFO } from './server.js';
import { GGUI_RENDER_SHELL_HTML, buildInlineRenderShellHtml } from './mcp-apps-outbound.js';

describe('serverInfo / appInfo report the shipped wave (ggui#622)', () => {
  it('MCP serverInfo.version is the wave, not a literal', () => {
    expect(DEFAULT_INFO.version).toBe(GGUI_WAVE_VERSION);
    expect(DEFAULT_INFO.name).toBe('ggui-mcp-server');
  });

  it("the inline shell's MCP Apps appInfo.version is the wave, not '1.0.0'", () => {
    const html = buildInlineRenderShellHtml('');
    expect(html).toContain(`appInfo:{name:'ggui-render',version:'${GGUI_WAVE_VERSION}'}`);
    expect(html).not.toContain("version:'1.0.0'");
  });

  it("the static ui://ggui/render template shell's appInfo.version is the wave too", () => {
    expect(GGUI_RENDER_SHELL_HTML).toContain(`appInfo:{name:'ggui-render',version:'${GGUI_WAVE_VERSION}'}`);
    expect(GGUI_RENDER_SHELL_HTML).not.toContain("version:'1.0.0'");
  });

  it('the wave is a real release, never the 0.0.1 placeholder class', () => {
    expect(DEFAULT_INFO.version).not.toBe('0.0.1');
    expect(GGUI_WAVE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
