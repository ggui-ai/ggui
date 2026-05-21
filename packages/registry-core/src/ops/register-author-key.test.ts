/**
 * `registerAuthorKey` op tests.
 */
import { describe, expect, it } from 'vitest';
import {
  derivePublicKeyId,
  generateEd25519Keypair,
} from '@ggui-ai/gadget-signing';
import { registerAuthorKey } from './register-author-key.js';
import { inMemoryRegistryStorage } from '../impls/memory-registry-storage.js';
import {
  AuthorKeyAlreadyExistsError,
  type RegistryStorage,
} from '../interfaces/registry-storage.js';
import { base64Encode } from '../utils/base64.js';
import type { AuthorKeyRow } from '../types.js';

const AUTHN = { subject: 'cognito-sub-alice' };

async function makeKeyBase64(): Promise<{
  publicKeyBase64: string;
  publicKey: Uint8Array;
  publicKeyId: string;
}> {
  const kp = await generateEd25519Keypair();
  return {
    publicKey: kp.publicKey,
    publicKeyBase64: base64Encode(kp.publicKey),
    publicKeyId: kp.publicKeyId,
  };
}

/**
 * Build a {@link RegistryStorage} that simulates the conditional-put
 * race window: the first `putAuthorKey({ ifNotExists: true })` call
 * throws {@link AuthorKeyAlreadyExistsError} (modelling "a concurrent
 * writer landed between this op's logic and the put"), and subsequent
 * `getAuthorKey` lookups return `racingRow`. Used by the M3 regression
 * pin to drive the op's fall-back-and-dispatch branch deterministic-
 * ally without relying on real wall-clock races.
 */
function makeRacingStorage(opts: {
  conditionalPutFailsOnce: boolean;
  racingRow: AuthorKeyRow;
}): RegistryStorage {
  const base = inMemoryRegistryStorage();
  let conditionalPutsRemaining = opts.conditionalPutFailsOnce ? 1 : 0;
  return {
    ...base,
    async getAuthorKey(subject, keyId) {
      if (
        subject === opts.racingRow.subject &&
        keyId === opts.racingRow.keyId
      ) {
        return opts.racingRow;
      }
      return base.getAuthorKey(subject, keyId);
    },
    async putAuthorKey(row, options) {
      if (
        options?.ifNotExists === true &&
        conditionalPutsRemaining > 0 &&
        row.subject === opts.racingRow.subject &&
        row.keyId === opts.racingRow.keyId
      ) {
        conditionalPutsRemaining -= 1;
        throw new AuthorKeyAlreadyExistsError(row.subject, row.keyId);
      }
      return base.putAuthorKey(row, options);
    },
  };
}

describe('registerAuthorKey', () => {
  it('writes a fresh row + 201 on first register', async () => {
    const storage = inMemoryRegistryStorage();
    const { publicKeyBase64, publicKey } = await makeKeyBase64();
    const result = await registerAuthorKey(
      { publicKeyBase64 },
      { storage, authn: AUTHN },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(result.body.subject).toBe(AUTHN.subject);
    expect(result.body.publicKeyBase64).toBe(publicKeyBase64);
    expect(result.body.keyId).toBe(derivePublicKeyId(publicKey));

    const row = await storage.getAuthorKey(AUTHN.subject, result.body.keyId);
    expect(row).not.toBeNull();
    expect(row?.publicKeyBase64).toBe(publicKeyBase64);
  });

  it('is idempotent on same-publicKey re-register → 200', async () => {
    const storage = inMemoryRegistryStorage();
    const { publicKeyBase64 } = await makeKeyBase64();
    const first = await registerAuthorKey(
      { publicKeyBase64 },
      { storage, authn: AUTHN },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.status).toBe(201);

    const second = await registerAuthorKey(
      { publicKeyBase64 },
      { storage, authn: AUTHN },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe(200);
    expect(second.body.keyId).toBe(first.body.keyId);
  });

  it('rejects empty publicKeyBase64 with 400 invalid_request', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await registerAuthorKey(
      { publicKeyBase64: '' },
      { storage, authn: AUTHN },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_request');
  });

  it('rejects malformed base64 with 400 invalid_request', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await registerAuthorKey(
      { publicKeyBase64: '!!!not-base64!!!' },
      { storage, authn: AUTHN },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_request');
  });

  it('rejects wrong-length key bytes with 400 invalid_request', async () => {
    const storage = inMemoryRegistryStorage();
    // 16 bytes — not 32.
    const wrongLen = base64Encode(new Uint8Array(16));
    const result = await registerAuthorKey(
      { publicKeyBase64: wrongLen },
      { storage, authn: AUTHN },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_request');
    expect(result.body.message).toMatch(/32 raw bytes/);
  });

  it('returns 409 key_conflict when a row exists with a different publicKey for the same (subject, keyId)', async () => {
    // Construct the conflict directly via storage.putAuthorKey: a row
    // with the SAME (subject, keyId) the new register call will derive,
    // but a DIFFERENT publicKeyBase64. The op should detect the mismatch
    // on its idempotency-read pass and short-circuit with 409 — exactly
    // the hash-collision branch that audit 2026-05-19 M4 flagged as
    // missing from coverage.
    const storage = inMemoryRegistryStorage();
    const incoming = await makeKeyBase64();
    const other = await makeKeyBase64();

    // Pre-seed: same subject + same keyId as `incoming`, but rotten
    // publicKeyBase64 carrying `other.publicKey`. In production the
    // only path to this state is a SHA-256-first-16-chars collision
    // (≈2^-64); we synthesize it here directly.
    await storage.putAuthorKey({
      subject: AUTHN.subject,
      keyId: incoming.publicKeyId,
      publicKeyBase64: other.publicKeyBase64,
    });

    const result = await registerAuthorKey(
      { publicKeyBase64: incoming.publicKeyBase64 },
      { storage, authn: AUTHN },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('key_conflict');
  });

  it('closes the TOCTOU race-window: conditional put fails, read-back returns the racing same-publicKey row → 200', async () => {
    // Audit 2026-05-19 M3 regression pin. Simulates the race where two
    // concurrent first-register requests for the SAME publicKey land
    // such that request B's conditional put loses to request A's
    // already-committed row. With same publicKey, the read-back must
    // dispatch 200 (idempotent re-register).
    const { publicKeyBase64, publicKeyId } = await makeKeyBase64();
    const winningRow: AuthorKeyRow = {
      subject: AUTHN.subject,
      keyId: publicKeyId,
      publicKeyBase64,
    };
    const storage = makeRacingStorage({
      conditionalPutFailsOnce: true,
      racingRow: winningRow,
    });

    const result = await registerAuthorKey(
      { publicKeyBase64 },
      { storage, authn: AUTHN },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.body.subject).toBe(AUTHN.subject);
    expect(result.body.keyId).toBe(publicKeyId);
    expect(result.body.publicKeyBase64).toBe(publicKeyBase64);
  });

  it('closes the TOCTOU race-window: conditional put fails, read-back returns a different-publicKey row → 409', async () => {
    // The mathematically improbable but well-defined branch: a SHA-256
    // first-16-chars collision lets two DIFFERENT publicKeys derive the
    // same keyId. Without the conditional put, the second writer used
    // to silently overwrite. With it, the second writer's conditional
    // put fails, the read-back surfaces the conflicting row, and the
    // op returns 409 deterministically.
    const incoming = await makeKeyBase64();
    const racing = await makeKeyBase64();
    const racingRow: AuthorKeyRow = {
      subject: AUTHN.subject,
      keyId: incoming.publicKeyId,
      // Different publicKey, same keyId — synthetic SHA-256-collision.
      publicKeyBase64: racing.publicKeyBase64,
    };
    const storage = makeRacingStorage({
      conditionalPutFailsOnce: true,
      racingRow,
    });

    const result = await registerAuthorKey(
      { publicKeyBase64: incoming.publicKeyBase64 },
      { storage, authn: AUTHN },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('key_conflict');
  });

  it('scopes the row to the authenticated subject (no cross-tenant write)', async () => {
    const storage = inMemoryRegistryStorage();
    const { publicKeyBase64 } = await makeKeyBase64();

    const alice = await registerAuthorKey(
      { publicKeyBase64 },
      { storage, authn: { subject: 'sub-alice' } },
    );
    const bob = await registerAuthorKey(
      { publicKeyBase64 },
      { storage, authn: { subject: 'sub-bob' } },
    );
    expect(alice.ok).toBe(true);
    expect(bob.ok).toBe(true);
    if (!alice.ok || !bob.ok) return;

    expect(alice.body.subject).toBe('sub-alice');
    expect(bob.body.subject).toBe('sub-bob');
    // Same keyId across both because derivation is publicKey-only.
    expect(alice.body.keyId).toBe(bob.body.keyId);

    // Both rows exist independently.
    const aliceRow = await storage.getAuthorKey('sub-alice', alice.body.keyId);
    const bobRow = await storage.getAuthorKey('sub-bob', bob.body.keyId);
    expect(aliceRow).not.toBeNull();
    expect(bobRow).not.toBeNull();
  });
});
