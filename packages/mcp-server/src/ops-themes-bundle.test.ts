/**
 * ops-themes bundle registration (ggui#598-C mount) — the factory
 * registers the three theme tools when `opsThemes` is bound, none when
 * absent, and classifies them on the control plane per the ops
 * default-deny rule: `ggui_ops_list_themes` is read-only and
 * single-call-allowlisted; register/delete stay confirm-gated.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryThemeStore } from '@ggui-ai/mcp-server-core/in-memory';
import { buildOpsBundleHandlers } from './server.js';
import { SINGLE_CALL_OPS } from './control-service.js';

const opsThemes = {
  apps: { get: async () => null } as never,
  themeStore: new InMemoryThemeStore(),
  coverageValidator: () => ({
    covered: true,
    uncovered: { light: [], dark: [] },
    inheritMatched: [],
    excluded: [],
  }),
  manifestTokens: ['--ggui-color-primary-500'],
  staticThemeIds: ['ggui-default'],
};

describe('buildOpsBundleHandlers — opsThemes', () => {
  it('registers the three theme tools when the bundle is bound', () => {
    const handlers = buildOpsBundleHandlers({ opsThemes } as never);
    const names = handlers.map((h) => h.name);
    expect(names).toContain('ggui_ops_register_theme');
    expect(names).toContain('ggui_ops_list_themes');
    expect(names).toContain('ggui_ops_delete_theme');
    for (const h of handlers.filter((x) => x.name.includes('theme'))) {
      expect(h.audience).toEqual(['ops']);
    }
  });

  it('registers none when the bundle is absent (dormant deployment)', () => {
    const names = buildOpsBundleHandlers({} as never).map((h) => h.name);
    expect(names.filter((n) => n.includes('_theme'))).toEqual([]);
  });

  it('list is single-call-allowlisted; register/delete stay confirm-gated by default-deny', () => {
    expect(SINGLE_CALL_OPS.has('ggui_ops_list_themes')).toBe(true);
    expect(SINGLE_CALL_OPS.has('ggui_ops_register_theme')).toBe(false);
    expect(SINGLE_CALL_OPS.has('ggui_ops_delete_theme')).toBe(false);
  });
});
