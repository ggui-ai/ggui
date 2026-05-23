/**
 * Pins the `ggui_runtime_refresh_bootstrap` handler shape (G14,
 * 2026-05-23):
 *
 *   - Successful refresh returns `{ok:true, envelope, expiresAt}`.
 *   - Closed refresh window returns `{ok:false, code:
 *     'REFRESH_WINDOW_CLOSED'}`.
 *   - Tampered / malformed envelope returns `{ok:false, code:
 *     'BOOTSTRAP_INVALID'}`.
 *   - Absent refresh seam (no `MCP_BOOTSTRAP_SECRET`-style wiring)
 *     returns `{ok:false, code: 'BOOTSTRAP_NOT_SUPPORTED'}`.
 *   - The handler carries `audience: ['runtime']` AND
 *     `_meta.ui.visibility: ['app']` so MCP Apps hosts route
 *     iframe-issued calls to it and the agent never sees it.
 */
import { describe, expect, it } from 'vitest';
import {
  createGguiRefreshBootstrapHandler,
  type BootstrapRefreshSeam,
} from './refresh-bootstrap.js';

const ctx = {
  appId: 'app_1',
  requestId: 'req_1',
};

function fakeSeam(
  result:
    | { ok: true; token: string; expiresAt: string }
    | { ok: false; reason: 'window_closed' | 'invalid' },
): BootstrapRefreshSeam {
  return { refresh: () => result };
}

describe('createGguiRefreshBootstrapHandler', () => {
  it('returns ok:true with the new envelope on a successful refresh', async () => {
    const handler = createGguiRefreshBootstrapHandler({
      refreshSeam: fakeSeam({
        ok: true,
        token: 'NEW.TOKEN',
        expiresAt: '2026-05-23T01:00:00.000Z',
      }),
    });
    const out = await handler.handler(
      { envelope: 'OLD.TOKEN' },
      ctx,
    );
    expect(out).toEqual({
      ok: true,
      envelope: 'NEW.TOKEN',
      expiresAt: '2026-05-23T01:00:00.000Z',
    });
  });

  it('returns REFRESH_WINDOW_CLOSED when the seam reports window_closed', async () => {
    const handler = createGguiRefreshBootstrapHandler({
      refreshSeam: fakeSeam({ ok: false, reason: 'window_closed' }),
    });
    const out = await handler.handler(
      { envelope: 'STALE.TOKEN' },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('REFRESH_WINDOW_CLOSED');
      expect(out.message).toMatch(/refresh window/i);
    }
  });

  it('returns BOOTSTRAP_INVALID when the seam reports invalid (tampered/malformed/wrong-kind)', async () => {
    const handler = createGguiRefreshBootstrapHandler({
      refreshSeam: fakeSeam({ ok: false, reason: 'invalid' }),
    });
    const out = await handler.handler(
      { envelope: 'TAMPERED.TOKEN' },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('BOOTSTRAP_INVALID');
  });

  it('returns BOOTSTRAP_NOT_SUPPORTED when no refresh seam is wired', async () => {
    const handler = createGguiRefreshBootstrapHandler();
    const out = await handler.handler(
      { envelope: 'OLD.TOKEN' },
      ctx,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('BOOTSTRAP_NOT_SUPPORTED');
  });

  it('returns BOOTSTRAP_INVALID on input validation failure (missing envelope)', async () => {
    const handler = createGguiRefreshBootstrapHandler({
      refreshSeam: fakeSeam({
        ok: true,
        token: 'NEW',
        expiresAt: '2026-05-23T01:00:00.000Z',
      }),
    });
    const out = await handler.handler({}, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('BOOTSTRAP_INVALID');
  });

  it('exposes runtime audience + app visibility (MCP Apps §401 plumbing)', () => {
    const handler = createGguiRefreshBootstrapHandler();
    expect(handler.name).toBe('ggui_runtime_refresh_bootstrap');
    expect(handler.audience).toEqual(['runtime']);
    expect(handler._meta).toEqual({ ui: { visibility: ['app'] } });
  });
});
