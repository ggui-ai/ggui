import { describe, expect, it } from 'vitest';
import {
  InMemorySessionStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import { gateShortCode } from './render-gate.js';
import { createRenderSigner } from './render-signing.js';

describe('gateShortCode', () => {
  // Parity gate for /r/<code> + /api/bootstrap/<code>. The two routes
  // expose the same render state in different content types; this
  // single chokepoint stops them drifting on lookup/revoke/sig/rate-
  // limit/audit. Hardening one route silently leaving the other
  // unhardened is THE capability-URL trap.

  async function setup() {
    const sessionStore = new InMemorySessionStore();
    const shortCodeIndex = new InMemoryShortCodeIndex();
    return { sessionStore, shortCodeIndex };
  }

  it('returns ok with binding+session when the code resolves to a live session', async () => {
    const { sessionStore, shortCodeIndex } = await setup();
    const session = await sessionStore.create({ appId: 'app-1' });
    await shortCodeIndex.put('abc123', {
      sessionId: session.id,
      appId: 'app-1',
    });
    const outcome = await gateShortCode({
      shortCode: 'abc123',
      shortCodeIndex,
      sessionStore,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.binding.sessionId).toBe(session.id);
      expect(outcome.binding.appId).toBe('app-1');
      expect(outcome.session.id).toBe(session.id);
    }
  });

  it('returns not_found when the shortCode is unknown', async () => {
    const { sessionStore, shortCodeIndex } = await setup();
    const outcome = await gateShortCode({
      shortCode: 'ghost',
      shortCodeIndex,
      sessionStore,
    });
    expect(outcome).toEqual({ ok: false, code: 'not_found' });
  });

  it('returns not_found after revoke (capability-lifecycle parity)', async () => {
    // This is the load-bearing C.3+C.5 interaction test. Revoke MUST
    // make the gate report not_found on both routes via lookup-null.
    const { sessionStore, shortCodeIndex } = await setup();
    const session = await sessionStore.create({ appId: 'app-1' });
    await shortCodeIndex.put('alive', {
      sessionId: session.id,
      appId: 'app-1',
    });
    // First call resolves.
    expect((await gateShortCode({
      shortCode: 'alive',
      shortCodeIndex,
      sessionStore,
    })).ok).toBe(true);
    // Revoke.
    await shortCodeIndex.revoke('alive');
    // Second call is gone.
    expect(await gateShortCode({
      shortCode: 'alive',
      shortCodeIndex,
      sessionStore,
    })).toEqual({ ok: false, code: 'not_found' });
  });

  it('returns session_missing (with logContext) when binding exists but session record vanished', async () => {
    // Edge: session deletion outpaced the index. The gate surfaces a
    // distinct code so /r/ can swap to a loading shell while
    // /api/bootstrap/ can log + still 404.
    const { sessionStore, shortCodeIndex } = await setup();
    await shortCodeIndex.put('orphan', {
      sessionId: 'sess-deleted',
      appId: 'app-1',
    });
    const outcome = await gateShortCode({
      shortCode: 'orphan',
      shortCodeIndex,
      sessionStore,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('session_missing');
      expect(outcome.logContext).toEqual({
        shortCode: 'orphan',
        sessionId: 'sess-deleted',
      });
    }
  });

  describe('signer integration (C.2)', () => {
    it('ok when signer + valid sig+exp are supplied', async () => {
      const { sessionStore, shortCodeIndex } = await setup();
      const signer = createRenderSigner({ secret: 'k'.repeat(64) });
      const session = await sessionStore.create({ appId: 'app-1' });
      await shortCodeIndex.put('signed-1', {
        sessionId: session.id,
        appId: 'app-1',
      });
      const { sig, exp } = signer.sign('signed-1');
      const outcome = await gateShortCode({
        shortCode: 'signed-1',
        shortCodeIndex,
        sessionStore,
        signer,
        signedQuery: { sig, exp: String(exp) },
      });
      expect(outcome.ok).toBe(true);
    });

    it('invalid_signature when sig is tampered', async () => {
      const { sessionStore, shortCodeIndex } = await setup();
      const signer = createRenderSigner({ secret: 'l'.repeat(64) });
      const session = await sessionStore.create({ appId: 'app-1' });
      await shortCodeIndex.put('signed-1', {
        sessionId: session.id,
        appId: 'app-1',
      });
      const { exp } = signer.sign('signed-1');
      const outcome = await gateShortCode({
        shortCode: 'signed-1',
        shortCodeIndex,
        sessionStore,
        signer,
        signedQuery: { sig: 'deadbeef'.repeat(8), exp: String(exp) },
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('invalid_signature');
    });

    it('malformed_signature when sig+exp are missing', async () => {
      const { sessionStore, shortCodeIndex } = await setup();
      const signer = createRenderSigner({ secret: 'm'.repeat(64) });
      const outcome = await gateShortCode({
        shortCode: 'anything',
        shortCodeIndex,
        sessionStore,
        signer,
        signedQuery: {},
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('malformed_signature');
    });

    it('expired when exp is past', async () => {
      const { sessionStore, shortCodeIndex } = await setup();
      let now = 1_700_000_000_000;
      const signer = createRenderSigner({
        secret: 'n'.repeat(64),
        ttlSeconds: 60,
        now: () => now,
      });
      const session = await sessionStore.create({ appId: 'app-1' });
      await shortCodeIndex.put('signed-1', {
        sessionId: session.id,
        appId: 'app-1',
      });
      const { sig, exp } = signer.sign('signed-1');
      // Jump past expiry.
      now += 120_000;
      const outcome = await gateShortCode({
        shortCode: 'signed-1',
        shortCodeIndex,
        sessionStore,
        signer,
        signedQuery: { sig, exp: String(exp) },
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('expired');
    });

    it('signature check runs BEFORE lookup — unknown shortCodes still fail signature first', async () => {
      // Property: a stranger probing random shortCodes hits sig-fail
      // before lookup, so the index isn't drilled by every garbage
      // request (DoS resistance + uniform timing).
      const { sessionStore, shortCodeIndex } = await setup();
      const signer = createRenderSigner({ secret: 'o'.repeat(64) });
      // Future exp so the expiry pre-check passes; sig is still
      // garbage so the HMAC compare fails.
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const outcome = await gateShortCode({
        shortCode: 'never-existed',
        shortCodeIndex,
        sessionStore,
        signer,
        signedQuery: { sig: 'deadbeef', exp: String(futureExp) },
      });
      expect(outcome.ok).toBe(false);
      // Sig check ran first → invalid_signature, NOT not_found.
      if (!outcome.ok) expect(outcome.code).toBe('invalid_signature');
    });

    it('no signer wired — sig+exp are ignored (legacy/opt-out mode)', async () => {
      const { sessionStore, shortCodeIndex } = await setup();
      const session = await sessionStore.create({ appId: 'app-1' });
      await shortCodeIndex.put('unsigned-1', {
        sessionId: session.id,
        appId: 'app-1',
      });
      const outcome = await gateShortCode({
        shortCode: 'unsigned-1',
        shortCodeIndex,
        sessionStore,
        // No signer + garbage query → still ok, legacy mode.
        signedQuery: { sig: 'whatever', exp: '0' },
      });
      expect(outcome.ok).toBe(true);
    });
  });
});
