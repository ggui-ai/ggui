import { describe, it, expect, vi, beforeEach } from 'vitest';

const posted: unknown[] = [];
vi.mock('../observability', () => ({ postObservabilityToParent: (e: unknown) => posted.push(e) }));
import { parseMetaFromGlobal } from '../meta-parse';

// ggui#987 §3.4 — the read door is never silent: a slice whose `theme`
// the wire schema refuses mounts WITHOUT it and the refusal reaches the
// embedding host as `app-theme-invalid`.
describe('parseMetaFromGlobal — a refused theme is reported, not swallowed', () => {
  beforeEach(() => {
    posted.length = 0;
  });

  it('drops the retired one-palette theme, keeps the slice, posts app-theme-invalid with the schema issues', () => {
    (globalThis as { __GGUI_META__?: unknown }).__GGUI_META__ = {
      'ai.ggui/render': {
        sessionId: 'sess-1',
        appId: 'app-1',
        runtimeUrl: 'https://runtime.example/bundle.js',
        codeUrl: 'https://code.example/component.js',
        theme: { mode: 'dark', cssVariables: { '--ggui-color-primary-600': '#7c3aed' } },
      },
    };
    const result = parseMetaFromGlobal();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.meta.theme).toBeUndefined();
    expect(posted).toHaveLength(1);
    const event = posted[0] as { kind: string; issues: string[] };
    expect(event.kind).toBe('app-theme-invalid');
    expect(event.issues.length).toBeGreaterThan(0);
  });

  it('a valid v2 theme posts nothing', () => {
    (globalThis as { __GGUI_META__?: unknown }).__GGUI_META__ = {
      'ai.ggui/render': {
        sessionId: 'sess-1',
        appId: 'app-1',
        runtimeUrl: 'https://runtime.example/bundle.js',
        codeUrl: 'https://code.example/component.js',
        theme: { overlayHash: 'ab'.repeat(32), overlays: { light: {}, dark: {} } },
      },
    };
    const result = parseMetaFromGlobal();
    expect(result.ok).toBe(true);
    expect(posted).toEqual([]);
  });
});
