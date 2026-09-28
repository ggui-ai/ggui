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
import {
  WsTokenReplayCache,
  DEFAULT_WS_TOKEN_TTL_SEC,
  mintWsToken,
  mintSessionToken,
  verifyToken,
  verifyWsTokenSignature,
} from './ws-tokens.js';

const SECRET = 'test-secret-32bytes-for-hmac-1234';

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

  it('rejects a session token verified as a ws token', () => {
    const { token } = mintSessionToken(
      { sessionId: 'sess_a', appId: 'app_a' },
      SECRET,
    );
    const verified = verifyToken(token, SECRET, 'ws');
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('wrong_kind');
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
    const { token } = mintSessionToken({ sessionId: 's-1', appId: 'app-1' }, SECRET);
    expect(verifyWsTokenSignature(token, SECRET)).toEqual({ ok: false, reason: 'wrong_kind' });
  });

  it('refuses a malformed envelope', () => {
    expect(verifyWsTokenSignature('no-dot-here', SECRET)).toEqual({ ok: false, reason: 'invalid_format' });
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
