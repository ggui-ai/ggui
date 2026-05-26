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
 *   - `refreshWsToken` happy path: expired-but-signed envelope
 *     returns a new token with the same `(sessionId, appId)` and a
 *     fresh `iat` / `exp` / `jti`.
 *   - Refresh window closure — past `iat + refreshWindowSec`, refresh
 *     rejects with `'refresh_window_closed'`.
 *   - Refresh rejects tampered envelopes (no second-chance HMAC).
 *   - `WsTokenReplayCache` still claims fresh jtis and rejects
 *     re-claims (the cache stays exported for opt-in single-use
 *     callers).
 *
 * Time is faked via `vi.useFakeTimers()` for deterministic exp checks.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  WsTokenReplayCache,
  DEFAULT_WS_TOKEN_REFRESH_WINDOW_MULTIPLIER,
  DEFAULT_WS_TOKEN_TTL_SEC,
  mintWsToken,
  mintSessionToken,
  refreshWsToken,
  verifyToken,
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

describe('refreshWsToken', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes an expired-but-signed envelope into a fresh token', () => {
    const { token, claims } = mintWsToken(
      { sessionId: 'sess_a', appId: 'app_a', ttlSec: 5 },
      SECRET,
    );
    // Advance past expiry, still inside refresh window (2 * 5s = 10s).
    vi.setSystemTime(new Date('2026-05-23T00:00:08Z'));
    const refreshed = refreshWsToken(token, SECRET, { ttlSec: 5 });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) throw new Error('unreachable');
    expect(refreshed.claims.sessionId).toBe('sess_a');
    expect(refreshed.claims.appId).toBe('app_a');
    expect(refreshed.claims.jti).not.toBe(claims.jti);
    expect(refreshed.claims.iat).toBeGreaterThan(claims.iat);
    expect(refreshed.claims.exp).toBeGreaterThan(claims.exp);

    // The fresh envelope verifies cleanly under the standard path.
    const verified = verifyToken(refreshed.token, SECRET, 'ws');
    expect(verified.ok).toBe(true);
  });

  it('refreshes a still-valid envelope (refresh is idempotent within TTL)', () => {
    const { token } = mintWsToken(
      { sessionId: 'sess_a', appId: 'app_a', ttlSec: 30 },
      SECRET,
    );
    const refreshed = refreshWsToken(token, SECRET, { ttlSec: 30 });
    expect(refreshed.ok).toBe(true);
  });

  it('rejects with `refresh_window_closed` past `iat + refreshWindowSec`', () => {
    const { token } = mintWsToken(
      { sessionId: 'sess_a', appId: 'app_a', ttlSec: 5 },
      SECRET,
    );
    // Refresh window = 2 * 5s = 10s. Advance 11s past iat.
    vi.setSystemTime(new Date('2026-05-23T00:00:11Z'));
    const refreshed = refreshWsToken(token, SECRET, { ttlSec: 5 });
    expect(refreshed.ok).toBe(false);
    if (!refreshed.ok) {
      expect(refreshed.reason).toBe('refresh_window_closed');
    }
  });

  it('respects an explicit refreshWindowSec override', () => {
    const { token } = mintWsToken(
      { sessionId: 'sess_a', appId: 'app_a', ttlSec: 5 },
      SECRET,
    );
    // Refresh-window override = 30s, well past default 10s.
    vi.setSystemTime(new Date('2026-05-23T00:00:20Z'));
    const refreshed = refreshWsToken(token, SECRET, {
      ttlSec: 5,
      refreshWindowSec: 30,
    });
    expect(refreshed.ok).toBe(true);
  });

  it('rejects a tampered envelope (no second-chance HMAC)', () => {
    const { token } = mintWsToken(
      { sessionId: 'sess_a', appId: 'app_a', ttlSec: 5 },
      SECRET,
    );
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    // Tampered AND expired — but tamper detection wins; the envelope
    // never reaches the refresh-window check.
    vi.setSystemTime(new Date('2026-05-23T00:00:08Z'));
    const refreshed = refreshWsToken(tampered, SECRET, { ttlSec: 5 });
    expect(refreshed.ok).toBe(false);
    if (!refreshed.ok) expect(refreshed.reason).toBe('invalid_signature');
  });

  it('rejects a session token (wrong kind)', () => {
    const { token } = mintSessionToken(
      { sessionId: 'sess_a', appId: 'app_a' },
      SECRET,
    );
    const refreshed = refreshWsToken(token, SECRET);
    expect(refreshed.ok).toBe(false);
    if (!refreshed.ok) expect(refreshed.reason).toBe('wrong_kind');
  });

  it('uses default refresh window when none supplied', () => {
    const { token } = mintWsToken(
      { sessionId: 'sess_a', appId: 'app_a' },
      SECRET,
    );
    // Just inside the default window: TTL=180s, multiplier=2 → 360s.
    vi.setSystemTime(
      new Date(
        Date.now() +
          (DEFAULT_WS_TOKEN_TTL_SEC *
            DEFAULT_WS_TOKEN_REFRESH_WINDOW_MULTIPLIER -
            5) *
            1000,
      ),
    );
    const inside = refreshWsToken(token, SECRET);
    expect(inside.ok).toBe(true);

    // Just outside.
    vi.setSystemTime(
      new Date(
        Date.now() +
          (DEFAULT_WS_TOKEN_TTL_SEC *
            DEFAULT_WS_TOKEN_REFRESH_WINDOW_MULTIPLIER +
            10) *
            1000,
      ),
    );
    const outside = refreshWsToken(token, SECRET);
    expect(outside.ok).toBe(false);
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
