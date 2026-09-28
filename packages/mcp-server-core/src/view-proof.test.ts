/**
 * ggui#1415 — the server side of the view-origin proof v1: the default key
 * id, the view key a key-issuing door mints, and verification in the
 * order that names the first failure. Proven against protocol's vector.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MCP_APP_AI_GGUI_VIEW_META_KEY,
  VIEW_PROOF_ROOT_MAX_CHARS,
  VIEW_ROOT_SRC,
  VIEW_PROOF_V1_VECTORS,
  formatViewProofV1,
  parseViewProof,
  viewKeyInputBytes,
  viewProofArgsBytes,
  viewProofCallBytes,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  ViewProofRepeatCache,
  defaultViewKid,
  deriveViewKey,
  verifyViewProof,
  type VerifyViewProofInput,
} from './view-proof.js';
import type { JsonValue } from '@ggui-ai/protocol';
import { mintViewRoot, verifyToken } from './ws-tokens.js';

const [vector] = VIEW_PROOF_V1_VECTORS;
const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const meta = (proof: unknown): Readonly<Record<string, unknown>> => ({ [MCP_APP_AI_GGUI_VIEW_META_KEY]: proof });
const call = (overrides: Partial<VerifyViewProofInput> = {}): VerifyViewProofInput => ({
  requestMeta: meta(vector.proof),
  toolName: 'ggui_runtime_submit_action',
  args: vector.args,
  sessionId: vector.args.sessionId,
  appId: vector.args.appId,
  ...overrides,
});

/**
 * The vector's proof with its `callmac` altered in its FIRST character, all
 * six of whose bits are significant, so the tag's bytes change. (Altering
 * the last character can touch only base64url's two ignored low bits: the
 * same bytes, another spelling, which the non-canonical test covers.)
 */
function tamperCallmac(proof: string): string {
  const at = proof.lastIndexOf('.') + 1;
  const swapped = proof[at] === 'A' ? 'B' : 'A';
  return proof.slice(0, at) + swapped + proof.slice(at + 1);
}

/** Sign the vector's call over `argmac` as given, under the vector's key. */
function signedCall(argmac: string): string {
  const K = deriveViewKey(vector.root, vector.secret);
  const callmac = b64u(
    createHmac('sha256', K)
      .update(viewProofCallBytes({ toolName: vector.toolName, nonce: vector.nonce, vtime: vector.vtime, flags: vector.flags, argmac }))
      .digest(),
  );
  return formatViewProofV1({ root: vector.root, nonce: vector.nonce, vtime: vector.vtime, flags: vector.flags, argmac, callmac });
}

/** Re-sign the vector's call over other arguments, under the vector's key: a view that signed those. */
function signedOver(args: VerifyViewProofInput['args']): string {
  const K = deriveViewKey(vector.root, vector.secret);
  const argmac = b64u(createHmac('sha256', K).update(viewProofArgsBytes('ggui_runtime_submit_action', args)).digest());
  const callmac = b64u(
    createHmac('sha256', K)
      .update(viewProofCallBytes({ toolName: vector.toolName, nonce: vector.nonce, vtime: vector.vtime, flags: vector.flags, argmac }))
      .digest(),
  );
  return formatViewProofV1({ root: vector.root, nonce: vector.nonce, vtime: vector.vtime, flags: vector.flags, argmac, callmac });
}

describe('the view key and its key id (ggui#1415)', () => {
  it('reproduces the vector: the default key id and the view key', () => {
    expect(defaultViewKid(vector.secret)).toBe(vector.kid);
    expect(b64u(deriveViewKey(vector.root, vector.secret))).toBe(vector.viewKey);
  });

  it('a key-issuing mint stamps the key id and the door, and its view key is the HMAC of its own root', () => {
    const minted = mintViewRoot({ sessionId: 'render_x', appId: 'app_x', src: 'read' }, 's3cret');
    const [root] = minted.token.split('.');
    expect(root).toBeDefined();
    const claims = JSON.parse(Buffer.from(root ?? '', 'base64url').toString('utf8'));
    expect(claims).toMatchObject({ sessionId: 'render_x', appId: 'app_x', kind: 'ws', kid: defaultViewKid('s3cret'), src: 'read' });
    const K = createHmac('sha256', Buffer.from('s3cret', 'utf8')).update(viewKeyInputBytes(root ?? '')).digest();
    expect(minted.viewKey).toBe(b64u(K));
    // Still an ordinary ws token to every verifier, and the verifier reads the stamps back.
    expect(verifyToken(minted.token, 's3cret', 'ws')).toMatchObject({
      ok: true,
      claims: { sessionId: 'render_x', kid: defaultViewKid('s3cret'), src: 'read' },
    });
    expect(minted.claims).toMatchObject({ kid: defaultViewKid('s3cret'), src: 'read' });
  });

  it('refuses a ws token whose stamps have the wrong shape, as it does a wrong rootIat', () => {
    const secret = 's3cret';
    const signed = (claims: object): string => {
      const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
    };
    const base = { sessionId: 'render_x', appId: 'app_x', kind: 'ws', iat: 1, exp: 4_000_000_000, jti: 'j' };
    expect(verifyToken(signed({ ...base, kid: 'k', src: 'result' }), secret, 'ws')).toMatchObject({
      ok: true,
      claims: { kid: 'k', src: 'result' },
    });
    expect(verifyToken(signed({ ...base, kid: 7 }), secret, 'ws')).toEqual({ ok: false, reason: 'malformed_claims' });
  });

  it('refuses a door it does not know, so a new door is accepted one release before any door mints with it (VERSION-POLICY §3.6)', () => {
    // Widening this set and minting with the new value in the same release
    // makes every older replica in a roll refuse that door's tokens.
    const secret = 's3cret';
    const payload = Buffer.from(
      JSON.stringify({ sessionId: 'render_x', appId: 'app_x', kind: 'ws', iat: 1, exp: 4_000_000_000, jti: 'j', src: 'console' }),
      'utf8',
    ).toString('base64url');
    const token = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
    expect(verifyToken(token, secret, 'ws')).toEqual({ ok: false, reason: 'malformed_claims' });
    // Every value of the one list verifies, and a mint can stamp each.
    for (const src of VIEW_ROOT_SRC) {
      expect(verifyToken(mintViewRoot({ sessionId: 'render_x', appId: 'app_x', src }, secret).token, secret, 'ws')).toMatchObject({
        ok: true,
        claims: { src },
      });
    }
  });

  it('keys a root exactly as long as a proof can carry, and a proof on it parses; one character more is not keyed', () => {
    const rootFor = (sessionId: string): string =>
      mintViewRoot({ sessionId, appId: 'a', src: 'result' }, 's3cret').token.split('.')[0] ?? '';
    let n = 400;
    while (rootFor('s'.repeat(n)).length < VIEW_PROOF_ROOT_MAX_CHARS) n += 1;
    const atLimit = mintViewRoot({ sessionId: 's'.repeat(n), appId: 'a', src: 'result' }, 's3cret');
    const root = atLimit.token.split('.')[0] ?? '';
    expect(root.length).toBe(VIEW_PROOF_ROOT_MAX_CHARS);
    expect(atLimit.viewKey).toBeDefined();
    const proof = formatViewProofV1({ root, nonce: vector.nonce, vtime: vector.vtime, flags: vector.flags, argmac: vector.argmac, callmac: vector.callmac });
    expect(parseViewProof(proof)).toMatchObject({ ok: true });
    const over = mintViewRoot({ sessionId: 's'.repeat(n + 1), appId: 'a', src: 'result' }, 's3cret');
    expect(over.token.split('.')[0]?.length).toBeGreaterThan(VIEW_PROOF_ROOT_MAX_CHARS);
    expect(over.viewKeyNotIssued).toBe('oversize');
  });

  it('issues no view key for a root longer than a proof can carry, and says so', () => {
    const minted = mintViewRoot({ sessionId: 's'.repeat(600), appId: 'a', src: 'result' }, 's3cret');
    expect(minted.token.split('.')[0]?.length).toBeGreaterThan(VIEW_PROOF_ROOT_MAX_CHARS);
    expect(minted.viewKey).toBeUndefined();
    expect(minted.viewKeyNotIssued).toBe('oversize');
  });
});

describe('verifyViewProof (ggui#1415)', () => {
  it('the vector is valid, with its observations', () => {
    expect(verifyViewProof(call(), vector.secret)).toEqual({
      verdict: 'valid',
      kid: vector.kid,
      src: 'result',
      rootIat: 1790000000,
      rootExp: 1790000180,
      vtime: 1790000123456,
      userActivation: true,
      nonce: vector.nonce,
    });
  });

  it('the tampered callmac really is another tag', () => {
    const tampered = tamperCallmac(vector.proof);
    const tag = (proof: string): Buffer => Buffer.from(proof.slice(proof.lastIndexOf('.') + 1), 'base64url');
    expect(tag(tampered).equals(tag(vector.proof))).toBe(false);
  });

  it('names the first failing check', () => {
    const cases: Array<[string, VerifyViewProofInput, 'missing' | 'invalid', string]> = [
      ['no _meta', call({ requestMeta: undefined }), 'missing', 'meta_absent'],
      ['_meta without the key', call({ requestMeta: { other: 'x' } }), 'missing', 'key_absent'],
      ['a number', call({ requestMeta: meta(7) }), 'invalid', 'malformed'],
      ['another version', call({ requestMeta: meta(vector.proof.replace(/^v1/, 'v2')) }), 'invalid', 'version_unknown'],
      ['another tool', call({ toolName: 'ggui_runtime_sync_context' }), 'invalid', 'bad_mac'],
      ['a tampered callmac', call({ requestMeta: meta(tamperCallmac(vector.proof)) }), 'invalid', 'bad_mac'],
      ['another session', call({ sessionId: 'render_other' }), 'invalid', 'session_mismatch'],
      ['another app', call({ appId: 'app_other' }), 'invalid', 'app_mismatch'],
      ['altered arguments', call({ args: { ...vector.args, actionId: 'ffffffff' } }), 'invalid', 'args_mismatch'],
    ];
    for (const [label, input, verdict, reason] of cases) {
      expect(verifyViewProof(input, vector.secret), label).toEqual({ verdict, reason });
    }
  });

  it('never throws: arguments the canonicalizer cannot take are verifier_error, with the class of what was thrown', () => {
    let deep: JsonValue = 'leaf';
    for (let i = 0; i < 200_000; i += 1) deep = [deep];
    const args = { ...vector.args, payload: { intent: 'submit', actionData: { deep } } };
    // The call tag is over argmac as sent, so it passes and the canonicalizer runs.
    const proof = signedCall(vector.argmac);
    expect(verifyViewProof(call({ requestMeta: meta(proof), args }), vector.secret)).toEqual({
      verdict: 'invalid',
      reason: 'verifier_error',
      errorClass: 'RangeError',
    });
  });

  it('another secret is unknown_key, never bad_mac: its key id differs', () => {
    expect(verifyViewProof(call(), 'another-secret')).toEqual({ verdict: 'invalid', reason: 'unknown_key' });
  });

  it('checks the call tag before the session and the app, so a stranger learns nothing from the order', () => {
    const tampered = tamperCallmac(vector.proof);
    expect(verifyViewProof(call({ requestMeta: meta(tampered), sessionId: 'render_other', appId: 'app_other' }), vector.secret)).toEqual({
      verdict: 'invalid',
      reason: 'bad_mac',
    });
  });

  it('a view that signed other arguments proves those, not the vector\'s', () => {
    const other = { ...vector.args, actionId: 'ffffffff' };
    const proof = signedOver(other);
    expect(verifyViewProof(call({ requestMeta: meta(proof), args: other }), vector.secret)).toMatchObject({ verdict: 'valid' });
    expect(verifyViewProof(call({ requestMeta: meta(proof) }), vector.secret)).toEqual({ verdict: 'invalid', reason: 'args_mismatch' });
  });

  it('verifies another tool against its own bound arguments, and reports a gesture without user activation', () => {
    const args = { sessionId: vector.args.sessionId, appId: vector.args.appId, snapshot: { draft: 'hi' } };
    const K = deriveViewKey(vector.root, vector.secret);
    const argmac = b64u(createHmac('sha256', K).update(viewProofArgsBytes('ggui_runtime_sync_context', args)).digest());
    const callmac = b64u(
      createHmac('sha256', K)
        .update(viewProofCallBytes({ toolName: 'ggui_runtime_sync_context', nonce: vector.nonce, vtime: vector.vtime, flags: '0', argmac }))
        .digest(),
    );
    const proof = formatViewProofV1({ root: vector.root, nonce: vector.nonce, vtime: vector.vtime, flags: '0', argmac, callmac });
    const input = call({ requestMeta: meta(proof), toolName: 'ggui_runtime_sync_context', args });
    expect(verifyViewProof(input, vector.secret)).toMatchObject({ verdict: 'valid', userActivation: false });
    // The same proof presented as submit_action's is another call.
    expect(verifyViewProof({ ...input, toolName: 'ggui_runtime_submit_action' }, vector.secret)).toEqual({
      verdict: 'invalid',
      reason: 'bad_mac',
    });
  });

  it('refuses a tag in a non-canonical base64url spelling of the same bytes', () => {
    // The last of 43 base64url characters carries 2 ignored low bits.
    const last = vector.callmac.at(-1) ?? '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const i = alphabet.indexOf(last);
    const sibling = alphabet[(i & ~3) | ((i + 1) & 3)] ?? last;
    expect(sibling).not.toBe(last);
    expect(Buffer.from(vector.callmac.slice(0, -1) + sibling, 'base64url')).toEqual(Buffer.from(vector.callmac, 'base64url'));
    const proof = vector.proof.slice(0, -1) + sibling;
    expect(verifyViewProof(call({ requestMeta: meta(proof) }), vector.secret)).toEqual({ verdict: 'invalid', reason: 'bad_mac' });
  });
});

describe('ViewProofRepeatCache (ggui#1415)', () => {
  it('reports a pair seen within the window, per session, and forgets it after', () => {
    let t = 0;
    const cache = new ViewProofRepeatCache(1_000, 100, () => t);
    expect(cache.observe('s1', 'n1')).toBe(false);
    expect(cache.observe('s1', 'n1')).toBe(true);
    expect(cache.observe('s2', 'n1')).toBe(false);
    t = 1_500;
    expect(cache.observe('s1', 'n1')).toBe(false);
  });

  it('stays bounded: the oldest pairs go first', () => {
    const cache = new ViewProofRepeatCache(60_000, 2, () => 0);
    cache.observe('s', 'a');
    cache.observe('s', 'b');
    cache.observe('s', 'c');
    expect(cache.observe('s', 'a')).toBe(false);
    expect(cache.observe('s', 'c')).toBe(true);
  });

  it('holds at most maxEntries observations, however often one pair repeats', () => {
    const cache = new ViewProofRepeatCache(60_000, 3, () => 0);
    for (let i = 0; i < 100; i += 1) cache.observe('s', 'x');
    expect(cache.size).toBe(1);
    expect(cache.observe('s', 'x')).toBe(true);
    cache.observe('s', 'a');
    cache.observe('s', 'b');
    expect(cache.size).toBe(3);
    // The held observations are now x, a, b; one more pushes x out.
    cache.observe('s', 'c');
    expect(cache.size).toBe(3);
    expect(cache.observe('s', 'x')).toBe(false);
  });
});
