/**
 * [E] (2026-08-10) — author-key lifecycle parity journeys for the OSS
 * registry server: `POST /author-keys` enrichment (createdAt + label),
 * `GET /author-keys` (list, bearer-required), and
 * `DELETE /author-keys/:keyId` (idempotent hard delete).
 *
 * Lives in its OWN file (not `server.test.ts`) deliberately: these
 * journeys pin the author-key wire contract every conforming registry
 * deployment serves, and the suite boots its own in-process server
 * per group.
 *
 * Same in-process strategy as `server.test.ts`: real
 * `createRegistryServer` on `port: 0`, wire-level `fetch`, memory
 * storage + a static bearer token.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateEd25519Keypair } from '@ggui-ai/gadget-signing';
import {
  bootServerHarness,
  HARNESS_SUBJECT,
  type ServerHarness,
} from './testing/server-harness.js';

const TEST_SUBJECT = HARNESS_SUBJECT;
const FIXED_NOW = '2026-08-10T12:00:00.000Z';

type Harness = ServerHarness;

async function registerKey(
  h: Harness,
  opts: { readonly label?: string } = {},
): Promise<{ keyId: string; publicKeyBase64: string }> {
  const kp = await generateEd25519Keypair();
  const publicKeyBase64 = Buffer.from(kp.publicKey).toString('base64');
  const res = await fetch(`${h.baseUrl}/author-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: h.authHeader },
    body: JSON.stringify({
      publicKeyBase64,
      ...(opts.label !== undefined ? { label: opts.label } : {}),
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { keyId: string };
  return { keyId: body.keyId, publicKeyBase64 };
}

describe('author-key lifecycle routes', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootServerHarness({ clock: () => new Date(FIXED_NOW) });
  });

  afterAll(async () => {
    await h.handle.stop();
  });

  it('POST /author-keys stamps createdAt from the server clock and persists the label', async () => {
    const kp = await generateEd25519Keypair();
    const publicKeyBase64 = Buffer.from(kp.publicKey).toString('base64');
    const res = await fetch(`${h.baseUrl}/author-keys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: h.authHeader,
      },
      body: JSON.stringify({ publicKeyBase64, label: 'parity laptop' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      keyId: string;
      createdAt?: string;
      label?: string;
    };
    expect(body.createdAt).toBe(FIXED_NOW);
    expect(body.label).toBe('parity laptop');

    const row = await h.storage.getAuthorKey(TEST_SUBJECT, body.keyId);
    expect(row?.createdAt).toBe(FIXED_NOW);
    expect(row?.label).toBe('parity laptop');
  });

  it('POST /author-keys 400s a non-string label', async () => {
    const kp = await generateEd25519Keypair();
    const res = await fetch(`${h.baseUrl}/author-keys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: h.authHeader,
      },
      body: JSON.stringify({
        publicKeyBase64: Buffer.from(kp.publicKey).toString('base64'),
        label: 42,
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'invalid_request',
    );
  });

  it('GET /author-keys 401s without a bearer token', async () => {
    const res = await fetch(`${h.baseUrl}/author-keys`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
  });

  it('GET /author-keys 401s on an invalid bearer token — never silent-anonymous', async () => {
    const res = await fetch(`${h.baseUrl}/author-keys`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
  });

  it('GET /author-keys lists the caller\'s registered keys with enrichment fields', async () => {
    const registered = await registerKey(h, { label: 'listed key' });
    const res = await fetch(`${h.baseUrl}/author-keys`, {
      headers: { authorization: h.authHeader },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subject: string;
      keys: readonly {
        keyId: string;
        publicKeyBase64: string;
        createdAt?: string;
        label?: string;
      }[];
    };
    expect(body.subject).toBe(TEST_SUBJECT);
    const entry = body.keys.find((k) => k.keyId === registered.keyId);
    expect(entry).toEqual({
      keyId: registered.keyId,
      publicKeyBase64: registered.publicKeyBase64,
      createdAt: FIXED_NOW,
      label: 'listed key',
    });
  });

  it('GET /author-keys never leaks another subject\'s keys', async () => {
    await h.storage.putAuthorKey({
      subject: 'someone-else',
      keyId: 'k-foreign',
      publicKeyBase64: 'AAAA',
    });
    const res = await fetch(`${h.baseUrl}/author-keys`, {
      headers: { authorization: h.authHeader },
    });
    const body = (await res.json()) as { keys: readonly { keyId: string }[] };
    expect(body.keys.some((k) => k.keyId === 'k-foreign')).toBe(false);
  });

  it('DELETE /author-keys/:keyId 401s without a bearer token', async () => {
    const res = await fetch(`${h.baseUrl}/author-keys/some-key`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('DELETE round-trip: register → delete (true) → re-delete (false) → list no longer shows it', async () => {
    const registered = await registerKey(h);

    const first = await fetch(
      `${h.baseUrl}/author-keys/${registered.keyId}`,
      { method: 'DELETE', headers: { authorization: h.authHeader } },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ keyId: registered.keyId, deleted: true });

    const second = await fetch(
      `${h.baseUrl}/author-keys/${registered.keyId}`,
      { method: 'DELETE', headers: { authorization: h.authHeader } },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      keyId: registered.keyId,
      deleted: false,
    });

    const list = await fetch(`${h.baseUrl}/author-keys`, {
      headers: { authorization: h.authHeader },
    });
    const body = (await list.json()) as { keys: readonly { keyId: string }[] };
    expect(body.keys.some((k) => k.keyId === registered.keyId)).toBe(false);
  });

  it('DELETE takes the verbatim base64url keyId — - and _ need no encoding', async () => {
    await h.storage.putAuthorKey({
      subject: TEST_SUBJECT,
      keyId: 'aB-cD_eF-gH_iJ-k',
      publicKeyBase64: 'AAAA',
    });
    const res = await fetch(`${h.baseUrl}/author-keys/aB-cD_eF-gH_iJ-k`, {
      method: 'DELETE',
      headers: { authorization: h.authHeader },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keyId: 'aB-cD_eF-gH_iJ-k', deleted: true });
  });

  it('DELETE is subject-scoped — another subject\'s key survives and the response mirrors absent', async () => {
    await h.storage.putAuthorKey({
      subject: 'someone-else',
      keyId: 'k-theirs',
      publicKeyBase64: 'BBBB',
    });
    const res = await fetch(`${h.baseUrl}/author-keys/k-theirs`, {
      method: 'DELETE',
      headers: { authorization: h.authHeader },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keyId: 'k-theirs', deleted: false });
    expect(await h.storage.getAuthorKey('someone-else', 'k-theirs')).not.toBe(
      null,
    );
  });
});
