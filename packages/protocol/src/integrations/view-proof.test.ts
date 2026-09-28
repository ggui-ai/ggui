/**
 * ggui#1415 — view-origin proof v1: the grammar, the exact MAC bytes and
 * the known-answer vector. Protocol holds no crypto; this test recomputes
 * the vector with `node:crypto` over the module's own byte builders, so
 * the vector is proven against this spec, not copied from elsewhere.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MCP_APP_AI_GGUI_VIEW_META_KEY,
  VIEW_ARGS_LABEL_V1,
  VIEW_CALL_LABEL_V1,
  VIEW_KID_LABEL_V1,
  VIEW_ORIGIN_UNPROVEN,
  VIEW_PROOF_MAX_CHARS,
  VIEW_PROOF_RELAY_SHAPE,
  VIEW_PROOF_V1_MAX_CHARS,
  VIEW_PROOF_V1_PATTERN,
  VIEW_PROOF_V1_VECTORS,
  formatViewProofV1,
  isViewProofTool,
  parseViewProof,
  viewKeyInputBytes,
  viewProofArgsBytes,
  viewProofBoundArgs,
  viewProofCallBytes,
} from './view-proof.js';
import type { JsonValue } from '../types/data-contract.js';

const [vector] = VIEW_PROOF_V1_VECTORS;
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const hmac = (key: string | Uint8Array, msg: Uint8Array | string): Uint8Array =>
  new Uint8Array(createHmac('sha256', typeof key === 'string' ? Buffer.from(key, 'utf8') : key).update(msg).digest());
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const rootOf = (claims: object): string => Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
const withRoot = (root: string): string =>
  formatViewProofV1({ root, nonce: vector.nonce, vtime: vector.vtime, flags: vector.flags, argmac: vector.argmac, callmac: vector.callmac });

describe('view-origin proof v1 — names and shapes (ggui#1415)', () => {
  it('rides one request key, under a door shape every version keeps', () => {
    expect(MCP_APP_AI_GGUI_VIEW_META_KEY).toBe('ai.ggui/view');
    expect(VIEW_PROOF_MAX_CHARS).toBe(1024);
    expect(VIEW_ORIGIN_UNPROVEN).toBe('VIEW_ORIGIN_UNPROVEN');
    expect(VIEW_PROOF_RELAY_SHAPE.test(vector.proof)).toBe(true);
    expect(VIEW_PROOF_RELAY_SHAPE.test('a'.repeat(1024))).toBe(true);
    expect(VIEW_PROOF_RELAY_SHAPE.test('a'.repeat(1025))).toBe(false);
    for (const bad of ['', 'v1 x', 'v1+x', 'v1/x', 'v1.é', 'v1\nx']) {
      expect(VIEW_PROOF_RELAY_SHAPE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('the v1 grammar accepts the vector and its longest form, and nothing looser', () => {
    expect(VIEW_PROOF_V1_PATTERN.test(vector.proof)).toBe(true);
    const longest = formatViewProofV1({
      root: 'A'.repeat(768),
      nonce: 'A'.repeat(22),
      vtime: '9'.repeat(15),
      flags: 'ff',
      argmac: 'A'.repeat(43),
      callmac: 'A'.repeat(43),
    });
    expect(longest.length).toBe(VIEW_PROOF_V1_MAX_CHARS);
    expect(VIEW_PROOF_V1_PATTERN.test(longest)).toBe(true);
    const variants = [
      vector.proof.replace('.1790000123456.', '.01790000123456.'), // vtime with a leading zero
      vector.proof.replace('.1.', '.F.'), // flags uppercase
      vector.proof.replace('.1.', '.fff.'), // flags too long
      vector.proof.replace('AAECAwQFBgcICQoLDA0ODw', 'AAECAwQFBgcICQoLDA0OD'), // nonce too short
    ];
    for (const v of variants) expect(VIEW_PROOF_V1_PATTERN.test(v), v.slice(0, 40)).toBe(false);
  });

  it('binds, per tool, exactly the fields a relay may not change', () => {
    expect(isViewProofTool('ggui_runtime_submit_action')).toBe(true);
    expect(isViewProofTool('ggui_runtime_refresh_ws_token')).toBe(false);
    expect(
      viewProofBoundArgs('ggui_runtime_pull', { sessionId: 's', sinceSequence: 3, limit: 10, wait: 25_000 }),
    ).toEqual({ sessionId: 's', sinceSequence: 3, limit: 10 });
    expect(viewProofBoundArgs('ggui_runtime_sync_context', { sessionId: 's', snapshot: {}, extra: 1 })).toEqual({
      sessionId: 's',
      snapshot: {},
    });
  });
});

describe('view-origin proof v1 — the MAC bytes (ggui#1415)', () => {
  it('A is the args label, LF, and the canonical JSON of the bound arguments', () => {
    expect(text(viewProofArgsBytes('ggui_runtime_submit_action', vector.args))).toBe(
      `${VIEW_ARGS_LABEL_V1}\n${vector.canonicalArgs}`,
    );
  });

  it('M is the call label and the call fields, LF-separated', () => {
    const call = { toolName: vector.toolName, nonce: vector.nonce, vtime: vector.vtime, flags: vector.flags, argmac: vector.argmac };
    expect(text(viewProofCallBytes(call))).toBe(
      [VIEW_CALL_LABEL_V1, vector.toolName, vector.nonce, vector.vtime, vector.flags, vector.argmac].join('\n'),
    );
  });

  it('the view key input is the key label, one NUL byte, then P', () => {
    const bytes = viewKeyInputBytes('abc');
    expect(Array.from(bytes)).toEqual([...Buffer.from('ai.ggui/view-key/v1', 'utf8'), 0x00, ...Buffer.from('abc', 'ascii')]);
  });

  it('refuses arguments JCS cannot encode instead of signing something else', () => {
    expect(() => viewProofArgsBytes('ggui_runtime_sync_context', { sessionId: 's', snapshot: { n: Number.NaN } })).toThrow();
  });
});

describe('view-origin proof v1 — the known-answer vector, recomputed with node:crypto (ggui#1415)', () => {
  it('the default key id, the view key, both tags and the proof all reproduce', () => {
    const kid = b64u(hmac(vector.secret, VIEW_KID_LABEL_V1)).slice(0, 8);
    expect(kid).toBe(vector.kid);
    const K = hmac(vector.secret, viewKeyInputBytes(vector.root));
    expect(b64u(K)).toBe(vector.viewKey);
    const argmac = b64u(hmac(K, viewProofArgsBytes('ggui_runtime_submit_action', vector.args)));
    expect(argmac).toBe(vector.argmac);
    const callmac = b64u(
      hmac(K, viewProofCallBytes({ toolName: vector.toolName, nonce: vector.nonce, vtime: vector.vtime, flags: vector.flags, argmac })),
    );
    expect(callmac).toBe(vector.callmac);
    const proof = formatViewProofV1({ root: vector.root, nonce: vector.nonce, vtime: vector.vtime, flags: vector.flags, argmac, callmac });
    expect(proof).toBe(vector.proof);
    expect(proof.length).toBe(372);
    expect(Buffer.from(new Uint8Array(16).map((_, i) => i)).toString('base64url')).toBe(vector.nonce);
  });
});

describe('parseViewProof (ggui#1415)', () => {
  it('parses the vector and decodes its root claims, unauthenticated', () => {
    const parsed = parseViewProof(vector.proof);
    expect(parsed).toEqual({
      ok: true,
      proof: {
        version: 'v1',
        root: vector.root,
        nonce: vector.nonce,
        vtime: vector.vtime,
        flags: vector.flags,
        argmac: vector.argmac,
        callmac: vector.callmac,
        claims: {
          sessionId: 'render_3f2a9c1e-7b4d-4e8a-9c2f-0d1e2f3a4b5c',
          appId: 'app_demo',
          kind: 'ws',
          iat: 1790000000,
          exp: 1790000180,
          jti: 'AAECAwQFBgcICQoL',
          kid: 'a_lK9Gzz',
          src: 'result',
        },
      },
    });
  });

  it('names why a value is not a proof, and never throws', () => {
    const claims = { sessionId: 's', appId: 'a', kind: 'ws', iat: 1, exp: 2, jti: 'j', kid: 'k' };
    const cases: Array<[JsonValue | undefined, string]> = [
      [undefined, 'malformed'],
      [42, 'malformed'],
      ['a'.repeat(1025), 'malformed'],
      ['v1.not a proof', 'malformed'],
      [vector.proof.replace(/^v1/, 'v2'), 'version_unknown'],
      ['v2.anything.goes', 'version_unknown'],
      [vector.proof.replace('.1.', '.F.'), 'malformed'],
      [withRoot(Buffer.from('not json at all').toString('base64url')), 'malformed'],
      [withRoot(rootOf({ ...claims, kid: undefined })), 'malformed'],
      [withRoot(rootOf({ ...claims, iat: '1' })), 'malformed'],
      [withRoot(rootOf({ ...claims, src: 'console' })), 'malformed'],
      [withRoot(rootOf({ ...claims, kind: 'session' })), 'wrong_kind'],
    ];
    for (const [value, reason] of cases) {
      const parsed = parseViewProof(value);
      expect(parsed, String(value).slice(0, 40)).toEqual({ ok: false, reason });
    }
    expect(parseViewProof(withRoot(rootOf(claims)))).toMatchObject({ ok: true, proof: { claims } });
  });
});
