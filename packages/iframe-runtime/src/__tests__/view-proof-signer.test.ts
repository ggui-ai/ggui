/**
 * ggui#1415 runtime items 3–5 — the view's prover. `withViewProof` is the
 * one wrapper every `tools/call` of the three app-only runtime tools goes
 * through: it sends the normalized arguments, and a proof at
 * `_meta["ai.ggui/view"]` when the view holds a root for the call's
 * session. It is synchronous and total: a failure means no proof, never a
 * throw and never a changed call.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MCP_APP_AI_GGUI_VIEW_META_KEY,
  VIEW_PROOF_V1_VECTORS,
  parseViewProof,
  viewProofArgsBytes,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { createViewRootHolder } from '../view-root.js';
import { createViewProver } from '../view-proof-signer.js';

const [vector] = VIEW_PROOF_V1_VECTORS;
const SESSION = vector.args.sessionId;
const nonceBytes = Uint8Array.from(Buffer.from(vector.nonce, 'base64url'));

function proverFor(opts: { root?: { root: string; key: string }; now?: () => number } = {}) {
  const roots = createViewRootHolder();
  const root = opts.root ?? { root: vector.root, key: vector.viewKey };
  roots.offer(SESSION, root);
  return createViewProver({
    roots,
    now: opts.now ?? (() => Number(vector.vtime)),
    randomBytes: (bytes) => bytes.set(nonceBytes.subarray(0, bytes.length)),
  });
}

const proofOf = (call: { _meta?: Record<string, string> }): string | undefined => call._meta?.[MCP_APP_AI_GGUI_VIEW_META_KEY];

describe('withViewProof (ggui#1415)', () => {
  it("reproduces the protocol's known-answer vector: same arguments sent, same proof", () => {
    const call = proverFor().withViewProof(vector.toolName, vector.args, { userActivation: true });
    expect(call).toEqual({
      name: vector.toolName,
      arguments: vector.args,
      _meta: { [MCP_APP_AI_GGUI_VIEW_META_KEY]: vector.proof },
    });
  });

  it('sends the arguments it signed: the JSON-normalized ones', () => {
    const args = {
      kind: 'dispatch',
      payload: { when: new Date('2026-09-28T10:00:00.000Z'), gone: undefined, n: 1 },
      sessionId: SESSION,
      appId: 'app_demo',
      actionId: 'a1',
      firedAt: '2026-09-28T10:00:00.000Z',
      notBound: 'x',
    };
    const call = proverFor().withViewProof('ggui_runtime_submit_action', args);
    const normalized = JSON.parse(JSON.stringify(args));
    expect(call.arguments).toEqual(normalized);
    expect(call.arguments).not.toHaveProperty('payload.gone');
    const parsed = parseViewProof(proofOf(call));
    if (!parsed.ok) throw new Error(`expected a proof, got ${parsed.reason}`);
    const key = Buffer.from(vector.viewKey, 'base64url');
    const argmac = createHmac('sha256', key)
      .update(viewProofArgsBytes('ggui_runtime_submit_action', normalized))
      .digest('base64url');
    expect(parsed.proof.argmac).toBe(argmac);
  });

  it('sets the user-activation flag only when the caller says the gesture carried it', () => {
    const prover = proverFor();
    const flagsOf = (userActivation?: boolean): string | undefined => {
      const parsed = parseViewProof(proofOf(prover.withViewProof(vector.toolName, vector.args, userActivation === undefined ? undefined : { userActivation })));
      return parsed.ok ? parsed.proof.flags : undefined;
    };
    expect(flagsOf(true)).toBe('1');
    expect(flagsOf(false)).toBe('0');
    expect(flagsOf()).toBe('0');
  });

  it('proves each of the three tools, and carries only the view key in _meta', () => {
    const prover = proverFor();
    for (const [name, args] of [
      ['ggui_runtime_sync_context', { sessionId: SESSION, appId: 'app_demo', snapshot: { draft: 'x' } }],
      ['ggui_runtime_pull', { sessionId: SESSION, sinceSequence: 3, limit: 10, wait: 25 }],
    ] as const) {
      const call = prover.withViewProof(name, args);
      expect(Object.keys(call._meta ?? {}), name).toEqual([MCP_APP_AI_GGUI_VIEW_META_KEY]);
      expect(parseViewProof(proofOf(call)).ok, name).toBe(true);
    }
  });

  it('passes every other tool through untouched: no proof, the same arguments', () => {
    const prover = proverFor();
    const args = { sessionId: SESSION, anything: new Date(0) };
    for (const name of ['ggui_runtime_refresh_ws_token', 'ggui_runtime_telemetry', 'acme_search', 'ggui_update']) {
      const call = prover.withViewProof(name, args);
      expect(call, name).toEqual({ name, arguments: args });
      expect(call.arguments, name).toBe(args);
    }
  });

  it('sends no proof for a session the view holds no root for, and still sends the call', () => {
    const call = proverFor().withViewProof('ggui_runtime_pull', { sessionId: 'another-session', sinceSequence: 0 });
    expect(call).toEqual({ name: 'ggui_runtime_pull', arguments: { sessionId: 'another-session', sinceSequence: 0 } });
  });

  it('is total: a key that is not base64url, a clock outside the grammar, or arguments JSON cannot carry mean no proof, never a throw', () => {
    const badKey = proverFor({ root: { root: vector.root, key: '!'.repeat(43) } });
    expect(proofOf(badKey.withViewProof(vector.toolName, vector.args))).toBeUndefined();

    const badClock = proverFor({ now: () => 0 });
    expect(proofOf(badClock.withViewProof(vector.toolName, vector.args))).toBeUndefined();

    const withBigInt = { ...vector.args, payload: { n: 1n } };
    const call = proverFor().withViewProof(vector.toolName, withBigInt);
    expect(call).toEqual({ name: vector.toolName, arguments: withBigInt });
  });
});
