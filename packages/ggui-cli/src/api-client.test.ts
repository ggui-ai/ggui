/**
 * Unit tests for `api-client.ts` authenticated endpoints.
 *
 * Strategy: mock `./auth-store.js` so `loadAuthSession` / `saveAuthSession`
 * never touch the filesystem, and mock global `fetch` per-test so no real
 * network I/O happens. Each test verifies the HTTP shape (method, path,
 * body) and the parsed response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthSessionDocument } from './auth-store.js';

// ─── hoisted mock vars ────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  loadAuthSession: vi.fn<() => AuthSessionDocument>(),
  saveAuthSession: vi.fn<(s: AuthSessionDocument) => void>(),
}));

vi.mock('./auth-store.js', () => ({
  loadAuthSession: mocks.loadAuthSession,
  saveAuthSession: mocks.saveAuthSession,
}));

// Import AFTER vi.mock so the mock is in place.
import { patchAppConfig } from './api-client.js';

// ─── shared fixture ───────────────────────────────────────────────────────────
const SESSION: AuthSessionDocument = {
  endpoint: 'https://api.ggui.ai',
  accessToken: 'cli_at_test',
  refreshToken: 'rt_test',
  accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  refreshExpiresAt: Math.floor(Date.now() / 1000) + 86400,
  writtenAt: new Date().toISOString(),
};

beforeEach(() => {
  mocks.loadAuthSession.mockReturnValue(SESSION);
  mocks.saveAuthSession.mockReset();
});

// ─── patchAppConfig ───────────────────────────────────────────────────────────
describe('patchAppConfig', () => {
  it('issues PATCH to /v1/apps/<appId> with body and returns parsed { updated }', async () => {
    const responseBody = { updated: ['gadgets'] };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await patchAppConfig('app12345', { gadgets: [] });

    expect(result).toEqual({ updated: ['gadgets'] });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.ggui.ai/v1/apps/app12345');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ gadgets: [] });
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer cli_at_test',
    );

    fetchSpy.mockRestore();
  });

  it('encodes special characters in appId', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ updated: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await patchAppConfig('app/id with spaces', { gadgets: [] });

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.ggui.ai/v1/apps/app%2Fid%20with%20spaces');

    fetchSpy.mockRestore();
  });

  it('propagates a non-200 response as ApiError', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'not_found', error_description: 'App not found' }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
      );

    await expect(patchAppConfig('missing-app', {})).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });

    fetchSpy.mockRestore();
  });
});
