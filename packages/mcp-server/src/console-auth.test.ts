/**
 * Unit tests for `console-auth.ts`. Covers the cookie mint/parse/
 * verify contract + the isolation invariants the auth plane depends
 * on:
 *
 *   - cookie value CAN'T verify as a bootstrap or session token
 *   - bootstrap / session tokens CAN'T verify as cookies
 *   - Set-Cookie header carries HttpOnly, SameSite=Strict, Max-Age by
 *     default; Secure is opt-in
 *   - extract/read helpers handle present/absent/malformed headers
 *     without throwing
 */
import { describe, expect, it } from 'vitest';
import {
  mintBootstrapToken,
  mintSessionToken,
  verifyToken,
} from '@ggui-ai/mcp-server-core';
import {
  CONSOLE_COOKIE_NAME,
  extractDevtoolCookie,
  mintDevtoolCookie,
  readDevtoolCookieFromHeaders,
  verifyDevtoolCookie,
} from './console-auth.js';

const SECRET = 'test-secret-' + 'a'.repeat(48);

describe('mintDevtoolCookie', () => {
  it('produces a token that verifies back to the same sessionId/appId', () => {
    const { cookieValue, sessionId, appId } = mintDevtoolCookie({
      sessionId: 's1',
      appId: 'a1',
      secret: SECRET,
    });
    expect(sessionId).toBe('s1');
    expect(appId).toBe('a1');
    const claims = verifyDevtoolCookie(cookieValue, SECRET);
    expect(claims).toEqual({ sessionId: 's1', appId: 'a1' });
  });

  it('Set-Cookie header carries HttpOnly + SameSite=Strict by default', () => {
    const { setCookieHeader } = mintDevtoolCookie({
      sessionId: 's1',
      appId: 'a1',
      secret: SECRET,
    });
    expect(setCookieHeader).toMatch(new RegExp(`^${CONSOLE_COOKIE_NAME}=`));
    expect(setCookieHeader).toMatch(/HttpOnly/);
    expect(setCookieHeader).toMatch(/SameSite=Strict/);
    expect(setCookieHeader).toMatch(/Path=\//);
    expect(setCookieHeader).toMatch(/Max-Age=\d+/);
    expect(setCookieHeader).not.toMatch(/Secure/);
  });

  it('Secure opt-in adds the Secure attribute', () => {
    const { setCookieHeader } = mintDevtoolCookie({
      sessionId: 's1',
      appId: 'a1',
      secret: SECRET,
      secure: true,
    });
    expect(setCookieHeader).toMatch(/; Secure/);
  });

  it('ttlSec override sets Max-Age accordingly', () => {
    const { setCookieHeader } = mintDevtoolCookie({
      sessionId: 's1',
      appId: 'a1',
      secret: SECRET,
      ttlSec: 60,
    });
    expect(setCookieHeader).toMatch(/Max-Age=60/);
  });

  it('sameSite override honored', () => {
    const { setCookieHeader } = mintDevtoolCookie({
      sessionId: 's1',
      appId: 'a1',
      secret: SECRET,
      sameSite: 'Lax',
    });
    expect(setCookieHeader).toMatch(/SameSite=Lax/);
  });
});

describe('verifyDevtoolCookie — isolation', () => {
  it('rejects bootstrap tokens minted with the same secret', () => {
    const { token } = mintBootstrapToken(
      { sessionId: 's1', appId: 'a1' },
      SECRET,
    );
    expect(verifyDevtoolCookie(token, SECRET)).toBeNull();
  });

  it('rejects session tokens minted with the same secret', () => {
    const { token } = mintSessionToken(
      { sessionId: 's1', appId: 'a1' },
      SECRET,
    );
    expect(verifyDevtoolCookie(token, SECRET)).toBeNull();
  });

  it('bootstrap tokens do NOT verify when the cookie kind is requested', () => {
    const { cookieValue } = mintDevtoolCookie({
      sessionId: 's1',
      appId: 'a1',
      secret: SECRET,
    });
    // Same value does NOT verify as bootstrap — kind claim guards it.
    const bootstrapVerify = verifyToken(cookieValue, SECRET, 'bootstrap');
    expect(bootstrapVerify.ok).toBe(false);
    // Same value does NOT verify as session either.
    const sessionVerify = verifyToken(cookieValue, SECRET, 'session');
    expect(sessionVerify.ok).toBe(false);
  });

  it('wrong secret rejects the cookie', () => {
    const { cookieValue } = mintDevtoolCookie({
      sessionId: 's1',
      appId: 'a1',
      secret: SECRET,
    });
    expect(verifyDevtoolCookie(cookieValue, 'other-secret')).toBeNull();
  });

  it('malformed cookie values return null (no throw)', () => {
    expect(verifyDevtoolCookie('not-a-token', SECRET)).toBeNull();
    expect(verifyDevtoolCookie('', SECRET)).toBeNull();
    expect(verifyDevtoolCookie('foo.bar', SECRET)).toBeNull();
  });
});

describe('extractDevtoolCookie', () => {
  it('returns null for missing header', () => {
    expect(extractDevtoolCookie(undefined)).toBeNull();
    expect(extractDevtoolCookie('')).toBeNull();
  });

  it('extracts the cookie value from a single-pair header', () => {
    expect(
      extractDevtoolCookie(`${CONSOLE_COOKIE_NAME}=abc.def`),
    ).toBe('abc.def');
  });

  it('extracts the cookie value from a multi-pair header', () => {
    expect(
      extractDevtoolCookie(
        `other=x; ${CONSOLE_COOKIE_NAME}=abc.def; another=y`,
      ),
    ).toBe('abc.def');
  });

  it('returns null when the cookie name is absent among other cookies', () => {
    expect(extractDevtoolCookie('other=x; another=y')).toBeNull();
  });

  it('URL-decodes the cookie value', () => {
    // `%2B` → `+`; token format uses base64url (no +) so this is
    // mostly defensive, but proves the decoder runs.
    const encoded = encodeURIComponent('abc+def/=');
    expect(
      extractDevtoolCookie(`${CONSOLE_COOKIE_NAME}=${encoded}`),
    ).toBe('abc+def/=');
  });
});

describe('readDevtoolCookieFromHeaders', () => {
  it('returns null when no cookie header is present', () => {
    expect(readDevtoolCookieFromHeaders({})).toBeNull();
  });

  it('reads from a string cookie header', () => {
    expect(
      readDevtoolCookieFromHeaders({
        cookie: `${CONSOLE_COOKIE_NAME}=abc.def`,
      }),
    ).toBe('abc.def');
  });
});
