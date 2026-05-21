import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GguiJsonV1 } from '@ggui-ai/project-config';
import { LocalUiRegistry } from '../local-registry/local-registry.js';
import { startDevServer, type DevServerHandle } from './http.js';
import { createSecurityPolicy } from './auth.js';

function makeGgui(include: string[]): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { slug: 'auth-smoke', name: 'Auth Smoke' },
    blueprints: { include },
    primitives: { packages: ['@ggui-ai/design/primitives'], local: [] },
    adapters: [],
  };
}

function writeUi(root: string, dir: string, id: string): void {
  const full = join(root, dir);
  mkdirSync(full, { recursive: true });
  writeFileSync(
    join(full, 'ggui.ui.json'),
    JSON.stringify({ id, name: id, contract: { intent: 'test' } }),
  );
}

describe('createSecurityPolicy', () => {
  it('generates a token when neither explicit nor env-provided', () => {
    const policy = createSecurityPolicy({ env: {} });
    expect(policy.tokenGenerated).toBe(true);
    expect(policy.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('accepts GGUI_DEV_TOKEN from env', () => {
    const policy = createSecurityPolicy({ env: { GGUI_DEV_TOKEN: 'preset-token' } });
    expect(policy.tokenGenerated).toBe(false);
    expect(policy.token).toBe('preset-token');
  });

  it('prefers explicit token over env', () => {
    const policy = createSecurityPolicy({
      token: 'explicit',
      env: { GGUI_DEV_TOKEN: 'ignored' },
    });
    expect(policy.token).toBe('explicit');
  });
});

describe('dev server with security policy enforced', () => {
  let tmp: string;
  let handle: DevServerHandle | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-cli-auth-'));
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  async function boot(opts: {
    token?: string;
    origins?: string[];
    env?: Record<string, string | undefined>;
  }): Promise<{ h: DevServerHandle; token: string }> {
    writeUi(tmp, 'ui/card', 'card');
    const manifest = makeGgui(['ui/**/ggui.ui.json']);
    const registry = new LocalUiRegistry({ projectRoot: tmp, manifest });
    const security = createSecurityPolicy({
      token: opts.token,
      extraOrigins: opts.origins,
      env: opts.env ?? {},
    });
    const h = await startDevServer({ registry, manifest, port: 0, security });
    handle = h;
    return { h, token: security.token };
  }

  function baseUrl(h: DevServerHandle): string {
    return `http://${h.host}:${h.port}`;
  }

  it('allows /health without a token', async () => {
    const { h } = await boot({ token: 't' });
    const res = await fetch(`${baseUrl(h)}/health`);
    expect(res.status).toBe(200);
  });

  it('rejects /uis without a bearer token (401)', async () => {
    const { h } = await boot({ token: 't' });
    const res = await fetch(`${baseUrl(h)}/uis`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
  });

  it('accepts /uis with the correct bearer token', async () => {
    const { h, token } = await boot({ token: 't' });
    const res = await fetch(`${baseUrl(h)}/uis`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong token (401, not 403)', async () => {
    const { h } = await boot({ token: 't' });
    const res = await fetch(`${baseUrl(h)}/uis`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a browser request with a disallowed Origin (403)', async () => {
    const { h, token } = await boot({ token: 't' });
    const res = await fetch(`${baseUrl(h)}/uis`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://evil.example.com',
      },
    });
    expect(res.status).toBe(403);
  });

  it('allows a localhost Origin and echoes CORS headers', async () => {
    const { h, token } = await boot({ token: 't' });
    const res = await fetch(`${baseUrl(h)}/uis`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'http://localhost:5173',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('vary')).toBe('origin');
  });

  it('allows an origin added via extraOrigins', async () => {
    const { h, token } = await boot({
      token: 't',
      origins: ['https://studio.example.com'],
    });
    const res = await fetch(`${baseUrl(h)}/uis`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://studio.example.com',
      },
    });
    expect(res.status).toBe(200);
  });

  it('handles OPTIONS preflight with 204 + CORS headers', async () => {
    const { h } = await boot({ token: 't' });
    const res = await fetch(`${baseUrl(h)}/uis`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-methods')).toMatch(/GET/);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/);
  });

  it('rejects OPTIONS preflight from a disallowed origin (403)', async () => {
    const { h } = await boot({ token: 't' });
    const res = await fetch(`${baseUrl(h)}/uis`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(403);
  });
});
