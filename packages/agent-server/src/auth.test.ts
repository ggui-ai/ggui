import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  createBearerTokenAuth,
  createGuestTokenAuth,
  defaultAuthorizeChat,
  mintGuestId,
  principalId,
  type AuthAdapter,
  type Principal,
} from './auth.js';

const SECRET = 'unit-test-secret-32-bytes-min-okk';

describe('mintGuestId', () => {
  it('returns guest_ prefix + 22-char base62 suffix', () => {
    const id = mintGuestId();
    expect(id.startsWith('guest_')).toBe(true);
    expect(id.slice(6)).toMatch(/^[0-9A-Za-z]{22}$/);
  });

  it('is collision-resistant in bulk', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = mintGuestId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe('principalId', () => {
  it('returns guestId for guest principals', () => {
    expect(
      principalId({
        kind: 'guest',
        guestId: 'guest_x',
        issuedAt: 0,
        expiresAt: 1,
      }),
    ).toBe('guest_x');
  });

  it('returns userId for user principals', () => {
    expect(principalId({ kind: 'user', userId: 'alice' })).toBe('alice');
  });
});

describe('defaultAuthorizeChat', () => {
  it('returns true on ownerId match', () => {
    const principal: Principal = {
      kind: 'guest',
      guestId: 'guest_a',
      issuedAt: 0,
      expiresAt: 1,
    };
    expect(
      defaultAuthorizeChat(principal, {
        chatId: 'c',
        ownerId: 'guest_a',
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toBe(true);
  });

  it('returns false on mismatch', () => {
    const principal: Principal = {
      kind: 'guest',
      guestId: 'guest_a',
      issuedAt: 0,
      expiresAt: 1,
    };
    expect(
      defaultAuthorizeChat(principal, {
        chatId: 'c',
        ownerId: 'guest_b',
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toBe(false);
  });
});

// Helper: build a real Hono router for the adapter's `mount` call so
// we exercise the same fetch path the agent-app uses.
async function withRouter<T>(
  adapter: AuthAdapter,
  cb: (request: (path: string, init?: RequestInit) => Promise<Response>) => Promise<T>,
): Promise<T> {
  const app = new Hono();
  const sub = new Hono();
  adapter.mount?.(sub);
  app.route('/auth', sub);
  return cb(async (path, init) =>
    app.request(`http://localhost${path}`, init),
  );
}

describe('createGuestTokenAuth', () => {
  it('warns once when no signingSecret is provided', () => {
    const logs: string[] = [];
    createGuestTokenAuth({ logSecretWarning: (line) => logs.push(line) });
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('no signingSecret provided');
  });

  it('POST /auth/guest returns a fresh {guestId, guestToken, expiresAt}', async () => {
    const adapter = createGuestTokenAuth({ signingSecret: SECRET });
    await withRouter(adapter, async (request) => {
      const res = await request('/auth/guest', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        guestId: string;
        guestToken: string;
        expiresAt: number;
      };
      expect(body.guestId.startsWith('guest_')).toBe(true);
      expect(typeof body.guestToken).toBe('string');
      expect(body.guestToken.length).toBeGreaterThan(20);
      expect(body.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  it('authenticate(req) with a freshly-minted token returns the matching Principal', async () => {
    const adapter = createGuestTokenAuth({ signingSecret: SECRET });
    let body!: { guestId: string; guestToken: string; expiresAt: number };
    await withRouter(adapter, async (request) => {
      const res = await request('/auth/guest', { method: 'POST' });
      body = (await res.json()) as typeof body;
    });
    const result = await adapter.authenticate(
      new Request('http://localhost/x', {
        headers: { Authorization: `Bearer ${body.guestToken}` },
      }),
    );
    if (!result || result.principal.kind !== 'guest') {
      throw new Error('expected guest principal');
    }
    expect(result.principal.guestId).toBe(body.guestId);
  });

  it('GET /auth/me returns the principal for a valid bearer', async () => {
    const adapter = createGuestTokenAuth({ signingSecret: SECRET });
    await withRouter(adapter, async (request) => {
      const mintRes = await request('/auth/guest', { method: 'POST' });
      const { guestToken, guestId } = (await mintRes.json()) as {
        guestId: string;
        guestToken: string;
      };
      const meRes = await request('/auth/me', {
        headers: { Authorization: `Bearer ${guestToken}` },
      });
      expect(meRes.status).toBe(200);
      const { principal } = (await meRes.json()) as { principal: Principal };
      if (principal.kind !== 'guest') throw new Error();
      expect(principal.guestId).toBe(guestId);
    });
  });

  it('GET /auth/me returns 401 with no bearer', async () => {
    const adapter = createGuestTokenAuth({ signingSecret: SECRET });
    await withRouter(adapter, async (request) => {
      const res = await request('/auth/me');
      expect(res.status).toBe(401);
    });
  });

  it('authenticate(req) returns null on tampered token', async () => {
    const adapter = createGuestTokenAuth({ signingSecret: SECRET });
    let token!: string;
    await withRouter(adapter, async (request) => {
      const res = await request('/auth/guest', { method: 'POST' });
      const body = (await res.json()) as { guestToken: string };
      token = body.guestToken;
    });
    // Flip the last sig char.
    const tampered = token.replace(/.$/, (last) => (last === 'a' ? 'b' : 'a'));
    const result = await adapter.authenticate(
      new Request('http://localhost/x', {
        headers: { Authorization: `Bearer ${tampered}` },
      }),
    );
    expect(result).toBeNull();
  });

  it('authenticate(req) returns null on a token with a different secret', async () => {
    const adapter = createGuestTokenAuth({ signingSecret: SECRET });
    const other = createGuestTokenAuth({
      signingSecret: 'a-completely-different-secret',
    });
    let token!: string;
    await withRouter(other, async (request) => {
      const res = await request('/auth/guest', { method: 'POST' });
      const body = (await res.json()) as { guestToken: string };
      token = body.guestToken;
    });
    const result = await adapter.authenticate(
      new Request('http://localhost/x', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(result).toBeNull();
  });

  it('authenticate(req) returns null on an expired token', async () => {
    // tokenLifetimeSeconds=0 → expiresAt === issuedAt → already expired
    // by the time authenticate runs (Date.now() advances past it).
    const adapter = createGuestTokenAuth({
      signingSecret: SECRET,
      tokenLifetimeSeconds: 0,
    });
    let token!: string;
    await withRouter(adapter, async (request) => {
      const res = await request('/auth/guest', { method: 'POST' });
      const body = (await res.json()) as { guestToken: string };
      token = body.guestToken;
    });
    // Sleep 5ms so Date.now() > expiresAt deterministically.
    await new Promise((r) => setTimeout(r, 5));
    const result = await adapter.authenticate(
      new Request('http://localhost/x', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(result).toBeNull();
  });

  it('POST /auth/logout returns 200 (stateless advice)', async () => {
    const adapter = createGuestTokenAuth({ signingSecret: SECRET });
    await withRouter(adapter, async (request) => {
      const res = await request('/auth/logout', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });
});

describe('createBearerTokenAuth', () => {
  const adapter = createBearerTokenAuth({
    tokens: {
      'sk-alice': { userId: 'alice', claims: { role: 'admin' } },
      'sk-bob': { userId: 'bob' },
    },
  });

  it('returns the user principal on a known token', async () => {
    const result = await adapter.authenticate(
      new Request('http://localhost/x', {
        headers: { Authorization: 'Bearer sk-alice' },
      }),
    );
    expect(result?.principal).toEqual({
      kind: 'user',
      userId: 'alice',
      claims: { role: 'admin' },
    });
  });

  it('omits claims when none were declared', async () => {
    const result = await adapter.authenticate(
      new Request('http://localhost/x', {
        headers: { Authorization: 'Bearer sk-bob' },
      }),
    );
    expect(result?.principal).toEqual({ kind: 'user', userId: 'bob' });
  });

  it('rejects unknown tokens with null (→ 401)', async () => {
    const result = await adapter.authenticate(
      new Request('http://localhost/x', {
        headers: { Authorization: 'Bearer sk-mallory' },
      }),
    );
    expect(result).toBeNull();
  });

  it('rejects missing Authorization header with null', async () => {
    const result = await adapter.authenticate(
      new Request('http://localhost/x'),
    );
    expect(result).toBeNull();
  });

  it('GET /auth/me returns 401 with no bearer / 200 with one', async () => {
    await withRouter(adapter, async (request) => {
      const noAuth = await request('/auth/me');
      expect(noAuth.status).toBe(401);
      const ok = await request('/auth/me', {
        headers: { Authorization: 'Bearer sk-bob' },
      });
      expect(ok.status).toBe(200);
      const { principal } = (await ok.json()) as { principal: Principal };
      expect(principal).toEqual({ kind: 'user', userId: 'bob' });
    });
  });

  it('does NOT mount POST /auth/guest (bearer model has no minting)', async () => {
    await withRouter(adapter, async (request) => {
      const res = await request('/auth/guest', { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });
});
