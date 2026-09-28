/**
 * Unit tests for `ws-tokens.ts`.
 *
 * Covers the G14 (2026-05-23) signed-envelope + refresh design:
 *
 *   - HMAC mint/verify roundtrip (`mintWsToken` → `verifyToken`).
 *   - Tamper detection (any byte change → `'invalid_signature'`).
 *   - Expiry surfaces a distinct `'expired'` reason (not collapsed
 *     into a generic failure).
 *   - Wrong-kind isolation — a session token MUST NOT verify as a
 *     ws token even when the signature is otherwise valid.
 *   - `verifyWsTokenSignature` verifies a signed ws envelope at ANY age
 *     (the first step of the authorized refresh, ggui#1496 part B), and
 *     refuses a tampered, foreign-secret, wrong-kind or malformed one.
 *   - `WsTokenReplayCache` still claims fresh jtis and rejects
 *     re-claims (the cache stays exported for opt-in single-use
 *     callers).
 *
 * Time is faked via `vi.useFakeTimers()` for deterministic exp checks.
 */
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  WsTokenReplayCache,
  DEFAULT_WS_TOKEN_TTL_SEC,
  mintWsToken,
  verifyToken,
  verifyWsTokenSignature,
  type WsTokenClaims,
} from './ws-tokens.js';

const SECRET = 'test-secret-32bytes-for-hmac-1234';

/** Tokens tag 14's own minters produced (ggui#1496 part B slice 2, ggui#1488). */
const N1 = JSON.parse(
  readFileSync(new URL('./__fixtures__/n1/ws-token.b68b964a7.json', import.meta.url), 'utf8'),
) as { secret: string; token: string; claims: WsTokenClaims; sessionToken: string };

describe('mintWsToken / verifyToken roundtrip', () => {
  it('mints a signed envelope that verifies cleanly within TTL', () => {
    const { token, claims } = mintWsToken(
      { sessionId: 'sess_a', appId: 'app_a' },
      SECRET,
    );
    expect(token.split('.')).toHaveLength(2);
    expect(claims.kind).toBe('ws');
    expect(claims.exp - claims.iat).toBe(DEFAULT_WS_TOKEN_TTL_SEC);

    const verified = verifyToken(token, SECRET, 'ws');
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sessionId).toBe('sess_a');
      expect(verified.claims.appId).toBe('app_a');
    }
  });

  it('detects single-byte tamper via HMAC mismatch', () => {
    const { token } = mintWsToken(
      { sessionId: 'sess_a', appId: 'app_a' },
      SECRET,
    );
    // Tamper the last byte of the signature.
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const verified = verifyToken(tampered, SECRET, 'ws');
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('invalid_signature');
  });

  it('returns `expired` when `now` is past `claims.exp`', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T00:00:00Z'));
    const { token } = mintWsToken(
      { sessionId: 'sess_a', appId: 'app_a', ttlSec: 5 },
      SECRET,
    );
    vi.setSystemTime(new Date('2026-05-23T00:00:10Z')); // 10s later
    const verified = verifyToken(token, SECRET, 'ws');
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('expired');
    vi.useRealTimers();
  });

  it('rejects a session token verified as a ws token: one tag 14 minted reads wrong_kind, not malformed (ggui#1488)', () => {
    const verified = verifyToken(N1.sessionToken, N1.secret, 'ws');
    expect(verified).toEqual({ ok: false, reason: 'wrong_kind' });
  });

  it('rejects under a different secret', () => {
    const { token } = mintWsToken(
      { sessionId: 'sess_a', appId: 'app_a' },
      SECRET,
    );
    const verified = verifyToken(token, 'other-secret', 'ws');
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('invalid_signature');
  });

  it('rejects a malformed token (no dot)', () => {
    const verified = verifyToken('garbage-no-dot', SECRET, 'ws');
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('invalid_format');
  });
});

describe('verifyWsTokenSignature — a ws envelope at ANY age (ggui#1496 part B)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies a long-expired envelope by its signature and kind, and returns its claims', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const { token, claims } = mintWsToken({ sessionId: 's-1', appId: 'app-1' }, SECRET);
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    expect(verifyToken(token, SECRET, 'ws')).toEqual({ ok: false, reason: 'expired' });
    const r = verifyWsTokenSignature(token, SECRET);
    expect(r).toEqual({ ok: true, claims });
  });

  it('refuses a tampered envelope', () => {
    const { token } = mintWsToken({ sessionId: 's-1', appId: 'app-1' }, SECRET);
    expect(verifyWsTokenSignature(`${token.slice(0, -2)}xx`, SECRET)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('refuses an envelope signed under another secret', () => {
    const { token } = mintWsToken({ sessionId: 's-1', appId: 'app-1' }, 'another-secret');
    expect(verifyWsTokenSignature(token, SECRET)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('refuses a session token: the kind must be ws', () => {
    expect(verifyWsTokenSignature(N1.sessionToken, N1.secret)).toEqual({ ok: false, reason: 'wrong_kind' });
  });

  it('refuses a malformed envelope', () => {
    expect(verifyWsTokenSignature('no-dot-here', SECRET)).toEqual({ ok: false, reason: 'invalid_format' });
  });
});

/** Sign an arbitrary claim payload in the envelope format, as a test oracle. */
function signPayload(payload: object, secret: string): string {
  const b64url = (b: Buffer): string =>
    b.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${payloadB64}.${b64url(createHmac('sha256', secret).update(payloadB64).digest())}`;
}

function payloadOf(token: string): Record<string, unknown> {
  const [payloadB64 = ''] = token.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
}


describe('rootIat — the root a possession renewal chains from (ggui#1496 part B, slice 2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a root mint writes exactly the six claims tag 14 wrote, and no rootIat', () => {
    const { token, claims } = mintWsToken({ sessionId: 's-1', appId: 'app-1' }, SECRET);
    const n1Keys = Object.keys(N1.claims).sort();
    expect(n1Keys).toEqual(['appId', 'exp', 'iat', 'jti', 'kind', 'sessionId']);
    expect(Object.keys(payloadOf(token)).sort()).toEqual(n1Keys);
    expect(Object.keys(claims).sort()).toEqual(n1Keys);
    expect(claims.rootIat).toBeUndefined();
  });

  it('a chained mint writes rootIat, and verifyToken returns it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T00:10:00Z'));
    const rootIat = Math.floor(new Date('2026-09-28T00:08:00Z').getTime() / 1000);
    const { token, claims } = mintWsToken({ sessionId: 's-1', appId: 'app-1', rootIat, ttlSec: 30 }, SECRET);
    expect(payloadOf(token).rootIat).toBe(rootIat);
    expect(claims.rootIat).toBe(rootIat);
    expect(claims.exp - claims.iat).toBe(30);
    expect(verifyToken(token, SECRET, 'ws')).toEqual({ ok: true, claims });
    expect(verifyWsTokenSignature(token, SECRET)).toEqual({ ok: true, claims });
  });

  it('an N−1 token (tag 14 minted it: six claims, no rootIat) verifies, with rootIat absent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((N1.claims.iat + 10) * 1000));
    const verified = verifyToken(N1.token, N1.secret, 'ws');
    expect(verified).toEqual({ ok: true, claims: N1.claims });
    expect(verified.ok && verified.claims.rootIat).toBeUndefined();
  });

  it('notAfter caps exp: a renewal never outlives it, however long its TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T00:10:00Z'));
    const now = Math.floor(Date.now() / 1000);
    const capped = mintWsToken({ sessionId: 's-1', appId: 'app-1', ttlSec: 180, notAfter: now + 30 }, SECRET);
    expect(capped.claims).toMatchObject({ iat: now, exp: now + 30 });
    // Control: a notAfter past iat + ttl leaves the TTL alone.
    const uncapped = mintWsToken({ sessionId: 's-1', appId: 'app-1', ttlSec: 180, notAfter: now + 900 }, SECRET);
    expect(uncapped.claims).toMatchObject({ iat: now, exp: now + 180 });
    // No second left: exp lands at iat, and the token verifies as expired.
    const spent = mintWsToken({ sessionId: 's-1', appId: 'app-1', ttlSec: 180, notAfter: now }, SECRET);
    expect(spent.claims.exp).toBe(spent.claims.iat);
    expect(verifyToken(spent.token, SECRET, 'ws')).toEqual({ ok: false, reason: 'expired' });
  });

  it('iat and the notAfter cap come from ONE clock read: a second boundary between reads cannot push exp past notAfter', () => {
    const notAfter = 1_790_000_000;
    // The first read lands just before the bound's second, and every later read just after it.
    const spy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce((notAfter - 1) * 1000 + 999)
      .mockReturnValue(notAfter * 1000 + 1);
    try {
      const { claims } = mintWsToken({ sessionId: 's-1', appId: 'app-1', ttlSec: 180, notAfter }, SECRET);
      expect(claims).toMatchObject({ iat: notAfter - 1, exp: notAfter });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('a rootIat that is not a number is malformed, whatever else the claims say', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T00:10:00Z'));
    const iat = Math.floor(Date.now() / 1000);
    const base = { sessionId: 's-1', appId: 'app-1', kind: 'ws', iat, exp: iat + 60, jti: 'j' };
    const bad = signPayload({ ...base, rootIat: String(iat) }, SECRET);
    expect(verifyToken(bad, SECRET, 'ws')).toEqual({ ok: false, reason: 'malformed_claims' });
    expect(verifyWsTokenSignature(bad, SECRET)).toEqual({ ok: false, reason: 'malformed_claims' });
    // Control, same oracle: a numeric rootIat verifies.
    const good = signPayload({ ...base, rootIat: iat - 30 }, SECRET);
    expect(verifyToken(good, SECRET, 'ws')).toEqual({ ok: true, claims: { ...base, kind: 'ws', rootIat: iat - 30 } });
  });
});

describe('WsTokenReplayCache (opt-in single-use)', () => {
  it('claims a fresh jti and rejects re-claim', () => {
    const cache = new WsTokenReplayCache();
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(cache.claim('jti-1', exp)).toBe(true);
    expect(cache.claim('jti-1', exp)).toBe(false);
    expect(cache.size()).toBe(1);
  });

  it('GCs entries past their exp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T00:00:00Z'));
    const cache = new WsTokenReplayCache();
    const exp = Math.floor(Date.now() / 1000) + 5;
    cache.claim('jti-1', exp);
    expect(cache.size()).toBe(1);
    vi.setSystemTime(new Date('2026-05-23T00:00:10Z'));
    expect(cache.size()).toBe(0);
    vi.useRealTimers();
  });
});
