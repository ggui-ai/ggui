/**
 * `DomainError` — the ONE composer of a Plane-2 error's wire text (ggui#880).
 *
 * The MCP SDK ships a thrown handler error as `{content:[{type:'text',
 * text: error.message}], isError: true}` and nothing else, so `message` IS
 * the wire. The base composes it as `<code>: <detail>` from a registry code;
 * a reader branches on `text.startsWith(code + ': ')` for a registered code
 * and on nothing else — which is why a detail that begins with another
 * registered code is refused at construction, while a tool-name prefix
 * (`ggui_render: …`) is prose and passes.
 */
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_MARKER,
  DomainError,
  DomainErrorDetailCollisionError,
  isDomainError,
  parseDomainErrorText,
} from '../domain-error';

class SessionGone extends DomainError<'session_not_found'> {
  constructor(readonly sessionId: string) {
    super('session_not_found', `GguiSession "${sessionId}" not found. Recovery: re-handshake.`);
  }
}

describe('DomainError — the wire text is `<code>: <detail>` (ggui#880)', () => {
  it('composes message from a registry code and the detail, and exposes both', () => {
    const err = new DomainError('handshake_not_found', 'handshakeId "h_1" not found.');
    expect(err.message).toBe('handshake_not_found: handshakeId "h_1" not found.');
    expect(err.code).toBe('handshake_not_found');
    expect(err.detail).toBe('handshakeId "h_1" not found.');
    expect(err.name).toBe('DomainError');
    expect(err).toBeInstanceOf(Error);
  });

  it('a subclass keeps its own name and the composed message; the text leads with the slug', () => {
    const err = new SessionGone('render_1');
    expect(err.name).toBe('SessionGone');
    expect(err.message.startsWith('session_not_found: ')).toBe(true);
    expect(err.sessionId).toBe('render_1');
    expect(err.code).toBe('session_not_found');
  });

  it('passes `cause` through', () => {
    const cause = new Error('inner');
    const err = new DomainError('blueprint_rejected', 'two findings', { cause });
    expect(err.cause).toBe(cause);
  });

  it('refuses an empty detail — the grammar requires one', () => {
    expect(() => new DomainError('invalid_complete', '')).toThrow(TypeError);
    expect(() => new DomainError('invalid_complete', '   ')).toThrow(TypeError);
  });

  it('refuses a detail that begins with a registered domain code — a nested slug would lie to the reader', () => {
    expect(() => new DomainError('session_not_found', 'handshake_not_found: nested')).toThrow(
      DomainErrorDetailCollisionError,
    );
  });

  it('refuses a detail that begins with a registered REFUSAL code — one text, one plane', () => {
    expect(() => new DomainError('contract_violation', 'app_policy_missing: no policy')).toThrow(
      DomainErrorDetailCollisionError,
    );
  });

  it('accepts a tool-name prefix in the detail — `ggui_render: …` is prose, never a code', () => {
    const err = new DomainError('handshake_not_found', 'ggui_render: handshakeId "h_1" not found.');
    expect(err.message).toBe('handshake_not_found: ggui_render: handshakeId "h_1" not found.');
  });
});

describe('isDomainError — marker-based, cross-realm safe', () => {
  it('is true for an instance and for a foreign object carrying the marker and the shape', () => {
    expect(isDomainError(new SessionGone('r'))).toBe(true);
    const foreign = Object.assign(new Error('session_not_found: elsewhere'), {
      [DOMAIN_ERROR_MARKER]: true as const,
      code: 'session_not_found',
      detail: 'elsewhere',
    });
    expect(isDomainError(foreign)).toBe(true);
  });

  it('is true for a marker-carrying object from another realm — no `Error` prototype in common', () => {
    const foreignRealm = {
      [DOMAIN_ERROR_MARKER]: true as const,
      name: 'SessionGone',
      message: 'session_not_found: elsewhere',
      code: 'session_not_found',
      detail: 'elsewhere',
    };
    expect(isDomainError(foreignRealm)).toBe(true);
  });

  it('is false for a plain Error that merely carries a `code`, and for non-errors', () => {
    expect(isDomainError(Object.assign(new Error('x'), { code: 'session_not_found' }))).toBe(false);
    expect(isDomainError({ code: 'session_not_found', message: 'session_not_found: x' })).toBe(false);
    expect(isDomainError(null)).toBe(false);
    expect(isDomainError('session_not_found: x')).toBe(false);
  });
});

describe('parseDomainErrorText — the reader side of the grammar', () => {
  it('reads `<code>: <detail>` for a registered code', () => {
    expect(parseDomainErrorText('session_not_found: GguiSession "r" not found.')).toEqual({
      code: 'session_not_found',
      detail: 'GguiSession "r" not found.',
    });
  });

  it('returns null for Plane-1-in-a-result text, tool-name prefixes, unregistered slugs and bare codes', () => {
    expect(parseDomainErrorText('MCP error -32602: Input validation error')).toBeNull();
    expect(parseDomainErrorText('ggui_render: handshakeId "h" not found')).toBeNull();
    expect(parseDomainErrorText('not_a_code: x')).toBeNull();
    expect(parseDomainErrorText('session_not_found:')).toBeNull();
    expect(parseDomainErrorText('session_not_found:   ')).toBeNull();
    expect(parseDomainErrorText('session_not_found')).toBeNull();
  });
});
