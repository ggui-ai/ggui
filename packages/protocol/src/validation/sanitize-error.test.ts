import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAUSED_BY_MAX_LENGTH,
  DEFAULT_CREDENTIAL_PATTERNS,
  TRUNCATION_MARKER,
  sanitizeCausedBy,
} from './sanitize-error';

describe('sanitizeCausedBy', () => {
  describe('credential redaction', () => {
    it('redacts Bearer tokens in stack traces', () => {
      const raw = 'at http.request (fetch.js:42)\n  Authorization: Bearer sk-abc123XYZ==\n  ...';
      const out = sanitizeCausedBy(raw);
      expect(out).not.toContain('sk-abc123XYZ');
      expect(out).toContain('[REDACTED]');
    });

    it('redacts Basic auth headers', () => {
      const raw = 'Request failed with Authorization: Basic dXNlcjpwYXNzd29yZA==';
      const out = sanitizeCausedBy(raw);
      expect(out).not.toContain('dXNlcjpwYXNzd29yZA');
    });

    it('redacts query-param tokens but keeps the key name', () => {
      const raw = 'GET https://api.example.com/v1?token=abc123&page=2';
      const out = sanitizeCausedBy(raw);
      expect(out).not.toContain('abc123');
      expect(out).toContain('?token=[REDACTED]');
      // Non-secret param preserved so operators can debug the request shape.
      expect(out).toContain('page=2');
    });

    it('redacts each of: token, api_key, access_token, refresh_token, password, secret, session_id', () => {
      const samples = [
        'url?token=T1',
        'url?api_key=K1',
        'url?api-key=K1',
        'url?access_token=A1',
        'url?refresh_token=R1',
        'url?password=P1',
        'url?secret=S1',
        'url?session_id=Z1',
      ];
      for (const s of samples) {
        const out = sanitizeCausedBy(s);
        expect(out).toMatch(/=\[REDACTED\]/);
      }
    });

    it('redacts env-var-style secrets (AWS_*, ANTHROPIC_API_KEY, etc.)', () => {
      const raw = [
        'Error: could not authenticate',
        'Context: AWS_SECRET_ACCESS_KEY=wJalrXUtn/K7MDENG',
        'Also: ANTHROPIC_API_KEY=sk-ant-xyz',
        'And: DATABASE_URL=postgres://user:pw@host/db',
      ].join('\n');
      const out = sanitizeCausedBy(raw);
      expect(out).not.toContain('wJalrXUtn');
      expect(out).not.toContain('sk-ant-xyz');
      expect(out).not.toContain('postgres://user:pw@host/db');
    });

    it('leaves unrelated stack content intact', () => {
      const raw = [
        'TypeError: Cannot read property foo of undefined',
        '  at someFunction (/app/src/file.ts:42:10)',
        '  at anotherFunction (/app/src/other.ts:15:5)',
      ].join('\n');
      const out = sanitizeCausedBy(raw);
      expect(out).toBe(raw);
    });
  });

  describe('truncation', () => {
    it('truncates output longer than maxLength', () => {
      const raw = 'x'.repeat(3000);
      const out = sanitizeCausedBy(raw, 100);
      expect(out.length).toBeLessThanOrEqual(100 + TRUNCATION_MARKER.length);
      expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    });

    it('does not truncate output within maxLength', () => {
      const raw = 'short error message';
      const out = sanitizeCausedBy(raw, 100);
      expect(out).toBe(raw);
      expect(out.endsWith(TRUNCATION_MARKER)).toBe(false);
    });

    it('default maxLength is 2048', () => {
      expect(DEFAULT_CAUSED_BY_MAX_LENGTH).toBe(2048);
      const raw = 'x'.repeat(2500);
      const out = sanitizeCausedBy(raw);
      expect(out.length).toBeLessThanOrEqual(2048 + TRUNCATION_MARKER.length);
    });
  });

  describe('determinism + purity', () => {
    it('returns the same output for the same input across invocations', () => {
      const raw = 'url?token=a1b2c3\nBearer xyz\n  at line';
      const out1 = sanitizeCausedBy(raw);
      const out2 = sanitizeCausedBy(raw);
      const out3 = sanitizeCausedBy(raw);
      expect(out1).toBe(out2);
      expect(out2).toBe(out3);
    });

    it('does not mutate input', () => {
      const raw = 'Bearer abc123';
      const before = raw;
      sanitizeCausedBy(raw);
      expect(raw).toBe(before);
    });
  });

  describe('custom patterns', () => {
    it('accepts a custom pattern set', () => {
      const raw = 'MY_CUSTOM_SECRET=xyz';
      const pattern = /MY_CUSTOM_SECRET=\S+/g;
      const out = sanitizeCausedBy(raw, 2048, [pattern]);
      expect(out).not.toContain('xyz');
      expect(out).toContain('[REDACTED]');
    });

    it('empty pattern set disables redaction (truncation still applies)', () => {
      const raw = 'Bearer leak-me';
      const out = sanitizeCausedBy(raw, 2048, []);
      // No patterns applied → raw leaks through.
      expect(out).toBe('Bearer leak-me');
    });
  });

  describe('DEFAULT_CREDENTIAL_PATTERNS', () => {
    it('is non-empty and covers the documented categories', () => {
      expect(DEFAULT_CREDENTIAL_PATTERNS.length).toBeGreaterThanOrEqual(4);
    });
  });
});
