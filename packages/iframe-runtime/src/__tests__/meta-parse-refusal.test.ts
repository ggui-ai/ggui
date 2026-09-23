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

// ggui#1093 belt (VERSION-POLICY §3.6) — the read door KEEPS a theme whose
// top-level members this release does not name, strips them, and the card
// says which: a newer writer's member is never silently swallowed.
describe('parseMetaFromGlobal — a stripped theme member is reported, not swallowed', () => {
  beforeEach(() => {
    posted.length = 0;
  });

  it('keeps the theme, drops the unknown member, posts app-theme-member-stripped with its key', () => {
    (globalThis as { __GGUI_META__?: unknown }).__GGUI_META__ = {
      'ai.ggui/render': {
        sessionId: 'sess-1',
        appId: 'app-1',
        runtimeUrl: 'https://runtime.example/bundle.js',
        codeUrl: 'https://code.example/component.js',
        theme: {
          overlayHash: 'ab'.repeat(32),
          overlays: { light: {}, dark: {} },
          sparkle: { intensity: 3 },
        },
      },
    };
    const result = parseMetaFromGlobal();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.meta.theme?.overlayHash).toBe('ab'.repeat(32));
    expect('sparkle' in (result.meta.theme ?? {})).toBe(false);
    expect(posted).toEqual([{ kind: 'app-theme-member-stripped', keys: ['sparkle'] }]);
  });

  it('a theme this release names entirely posts nothing', () => {
    (globalThis as { __GGUI_META__?: unknown }).__GGUI_META__ = {
      'ai.ggui/render': {
        sessionId: 'sess-1',
        appId: 'app-1',
        runtimeUrl: 'https://runtime.example/bundle.js',
        codeUrl: 'https://code.example/component.js',
        theme: {
          overlayHash: 'ab'.repeat(32),
          overlays: { light: {}, dark: {} },
          fonts: [{ family: 'Acme', src: 'https://fonts.acme.example/a.woff2' }],
        },
      },
    };
    expect(parseMetaFromGlobal().ok).toBe(true);
    expect(posted).toEqual([]);
  });
});

// ggui#1178 — the action contract rides the slice through the same kind of
// tolerant read door as the theme: a malformed `actionSpec` mounts WITHOUT
// it and says so; an entry member this release does not name is stripped
// and named; neither degradation is silent.
describe('parseMetaFromGlobal — the slice\'s action contract is never dropped silently', () => {
  beforeEach(() => {
    posted.length = 0;
  });

  it('drops a malformed actionSpec, keeps the slice, posts action-spec-invalid with the schema issues', () => {
    (globalThis as { __GGUI_META__?: unknown }).__GGUI_META__ = {
      'ai.ggui/render': {
        sessionId: 'sess-1',
        appId: 'app-1',
        runtimeUrl: 'https://runtime.example/bundle.js',
        codeUrl: 'https://code.example/component.js',
        actionSpec: { submit: { label: 42 } },
      },
    };
    const result = parseMetaFromGlobal();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.meta.actionSpec).toBeUndefined();
    expect(posted).toHaveLength(1);
    const event = posted[0] as { kind: string; issues: string[] };
    expect(event.kind).toBe('action-spec-invalid');
    expect(event.issues.some((i) => i.startsWith('submit.label'))).toBe(true);
  });

  it('keeps the actionSpec, drops an unknown entry member, posts action-spec-member-stripped with its path', () => {
    (globalThis as { __GGUI_META__?: unknown }).__GGUI_META__ = {
      'ai.ggui/render': {
        sessionId: 'sess-1',
        appId: 'app-1',
        runtimeUrl: 'https://runtime.example/bundle.js',
        codeUrl: 'https://code.example/component.js',
        actionSpec: { submit: { label: 'Submit', oneShot: true, futureEntryMember: 1 } },
      },
    };
    const result = parseMetaFromGlobal();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.meta.actionSpec).toEqual({ submit: { label: 'Submit', oneShot: true } });
    expect(posted).toEqual([
      { kind: 'action-spec-member-stripped', keys: ['submit.futureEntryMember'] },
    ]);
  });

  it('an actionSpec this release names entirely rides the slice and posts nothing', () => {
    (globalThis as { __GGUI_META__?: unknown }).__GGUI_META__ = {
      'ai.ggui/render': {
        sessionId: 'sess-1',
        appId: 'app-1',
        runtimeUrl: 'https://runtime.example/bundle.js',
        codeUrl: 'https://code.example/component.js',
        actionSpec: { submit: { label: 'Submit', oneShot: true } },
      },
    };
    const result = parseMetaFromGlobal();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.meta.actionSpec).toEqual({ submit: { label: 'Submit', oneShot: true } });
    expect(posted).toEqual([]);
  });
});

// ggui#1223 — the card's spent oneShot names ride the slice; a malformed value mounts WITHOUT it
// (the runtime keeps its in-memory guard alone) and says so.
describe('parseMetaFromGlobal — the spent oneShot set is never dropped silently', () => {
  beforeEach(() => {
    posted.length = 0;
  });
  const slice = (spentOneShots: unknown) => ({
    'ai.ggui/render': {
      sessionId: 'sess-1',
      appId: 'app-1',
      runtimeUrl: 'https://runtime.example/bundle.js',
      codeUrl: 'https://code.example/component.js',
      spentOneShots,
    },
  });

  it('carries a valid spentOneShots through validateMeta and posts nothing', () => {
    (globalThis as { __GGUI_META__?: unknown }).__GGUI_META__ = slice(['submit']);
    const result = parseMetaFromGlobal();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.meta.spentOneShots).toEqual(['submit']);
    expect(posted).toEqual([]);
  });

  it('drops a malformed spentOneShots, keeps the slice, posts spent-one-shots-invalid with the issues', () => {
    (globalThis as { __GGUI_META__?: unknown }).__GGUI_META__ = slice([7]);
    const result = parseMetaFromGlobal();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.meta.spentOneShots).toBeUndefined();
    expect(posted).toHaveLength(1);
    const event = posted[0] as { kind: string; issues: string[] };
    expect(event.kind).toBe('spent-one-shots-invalid');
    expect(event.issues.length).toBeGreaterThan(0);
  });
});
