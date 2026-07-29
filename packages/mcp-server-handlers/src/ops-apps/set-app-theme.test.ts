import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { AppNotFoundError } from './types.js';
import { createSetAppThemeHandler } from './set-app-theme.js';
import { InMemoryAppsSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

const validTheme = {
  mode: 'dark',
  cssVariables: {
    '--ggui-color-surface': '#111827',
    '--ggui-color-onSurface': '#f9fafb',
  },
  name: 'midnight',
};

describe('createSetAppThemeHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createSetAppThemeHandler({
      apps: new InMemoryAppsSource(),
    });
    expect(handler.name).toBe('ggui_ops_set_app_theme');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createSetAppThemeHandler — happy path', () => {
  it('persists the theme and echoes it back', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({ ownerSub: 'user-1' });
    const handler = createSetAppThemeHandler({ apps });
    const result = await handler.handler(
      { appId: created.appId, theme: validTheme },
      makeCtx(),
    );
    expect(result.appId).toBe(created.appId);
    expect(result.theme).toEqual(validTheme);
    expect(result.updatedAt.length).toBeGreaterThan(0);
    expect(apps.getTheme(created.appId)).toEqual(validTheme);
  });
});

describe('createSetAppThemeHandler — schema validation', () => {
  it('rejects css-variable keys outside the --ggui-* namespace', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({ ownerSub: 'user-1' });
    const handler = createSetAppThemeHandler({ apps });
    await expect(
      handler.handler(
        {
          appId: created.appId,
          theme: {
            mode: 'light',
            cssVariables: { '--evil-var': 'red' },
          },
        },
        makeCtx(),
      ),
    ).rejects.toThrow();
    expect(apps.getTheme(created.appId)).toBeUndefined();
  });

  it('rejects breakout characters in values', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({ ownerSub: 'user-1' });
    const handler = createSetAppThemeHandler({ apps });
    await expect(
      handler.handler(
        {
          appId: created.appId,
          theme: {
            mode: 'light',
            cssVariables: { '--ggui-color-surface': 'red; } body {' },
          },
        },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });

  it('rejects unknown top-level theme keys (.strict())', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({ ownerSub: 'user-1' });
    const handler = createSetAppThemeHandler({ apps });
    await expect(
      handler.handler(
        {
          appId: created.appId,
          theme: { ...validTheme, sneaky: true },
        },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });
});

describe('createSetAppThemeHandler — not found + tenancy', () => {
  it('throws AppNotFoundError when the id is unknown', async () => {
    const handler = createSetAppThemeHandler({
      apps: new InMemoryAppsSource(),
    });
    await expect(
      handler.handler({ appId: 'app_nope', theme: validTheme }, makeCtx()),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('rejects cross-user writes with the uniform AppNotFoundError', async () => {
    const apps = new InMemoryAppsSource();
    const other = await apps.create({ ownerSub: 'user-2' });
    const handler = createSetAppThemeHandler({ apps });
    await expect(
      handler.handler(
        { appId: other.appId, theme: validTheme },
        makeCtx({ userId: 'user-1' }),
      ),
    ).rejects.toBeInstanceOf(AppNotFoundError);
    expect(apps.getTheme(other.appId)).toBeUndefined();
  });

  it('throws on empty identity', async () => {
    const handler = createSetAppThemeHandler({
      apps: new InMemoryAppsSource(),
    });
    await expect(
      handler.handler(
        { appId: 'x', theme: validTheme },
        { appId: '', requestId: 'req-3' },
      ),
    ).rejects.toThrow();
  });
});
