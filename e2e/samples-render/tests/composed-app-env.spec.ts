/**
 * ggui#1861 — the composed app's environment: a caller's `extraEnv` reaches
 * the processes, and it can never replace a key the harness owns. Pure: no
 * browser, no boot.
 */
import { expect, test } from '@playwright/test';
import { composedAppEnv } from './composed-app-harness';

test.describe('composedAppEnv', () => {
  test('extraEnv reaches the app, beside the harness keys and the base env', () => {
    const env = composedAppEnv({ sdk: 'claude-agent-sdk', extraEnv: { GGUI_MCP_HEADERS: '{"X-Request-Source":"docs"}' } }, '/tmp/app', { PATH: '/bin' });
    expect(env.GGUI_MCP_HEADERS).toBe('{"X-Request-Source":"docs"}');
    expect(env.PATH).toBe('/bin');
    expect(env.SDK).toBe('claude-agent-sdk');
    expect(env.APP_DIR).toBe('/tmp/app');
  });

  test('without extraEnv, nothing extra is added', () => {
    const env = composedAppEnv({ sdk: 'claude-agent-sdk' }, '/tmp/app', {});
    expect(env.GGUI_MCP_HEADERS).toBeUndefined();
  });

  test('extraEnv naming a harness key is refused, not applied', () => {
    expect(() =>
      composedAppEnv({ sdk: 'claude-agent-sdk', cloudGgui: { mcpUrl: 'https://x/mcp', bearer: 'b' }, extraEnv: { GGUI_MCP_URL: 'https://y/mcp' } }, '/tmp/app', {}),
    ).toThrow('extraEnv may not set GGUI_MCP_URL');
  });
});
