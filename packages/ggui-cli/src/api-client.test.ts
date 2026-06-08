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
import { patchAppConfig, setAppProviderKey } from './api-client.js';

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

// ─── setAppProviderKey ────────────────────────────────────────────────────────
describe('setAppProviderKey', () => {
  it('POSTs to /v1/apps/<appId>/provider-keys with provider + plaintextKey', async () => {
    const responseBody = { provider: 'anthropic', lastFour: 'xYz1', appId: 'app_test1' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await setAppProviderKey('app_test1', 'anthropic', 'sk-ant-secret');

    expect(result).toEqual(responseBody);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.ggui.ai/v1/apps/app_test1/provider-keys');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ provider: 'anthropic', plaintextKey: 'sk-ant-secret' });
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer cli_at_test');

    fetchSpy.mockRestore();
  });

  it('includes optional label when provided', async () => {
    const responseBody = { provider: 'openai', lastFour: 'ab12', appId: 'app_test2' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await setAppProviderKey('app_test2', 'openai', 'sk-openai-key', 'my-label');

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ provider: 'openai', plaintextKey: 'sk-openai-key', label: 'my-label' });

    fetchSpy.mockRestore();
  });

  it('encodes special characters in appId', async () => {
    const responseBody = { provider: 'google', lastFour: 'cd34', appId: 'app/special' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await setAppProviderKey('app/special', 'google', 'AIza-secret');

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.ggui.ai/v1/apps/app%2Fspecial/provider-keys');

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

    await expect(setAppProviderKey('missing', 'anthropic', 'key')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });

    fetchSpy.mockRestore();
  });
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
