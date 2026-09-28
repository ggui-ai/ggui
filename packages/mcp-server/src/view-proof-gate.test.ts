/**
 * ggui#1415 — the view-origin proof's measuring gate: what it puts on the
 * handler context and the `tool_invoked` line for each verdict, the era it
 * classifies a `required` call's session into, and that it never refuses,
 * fails or changes a call.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ZodRawShape } from 'zod';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { mintViewRoot } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '@ggui-ai/mcp-server-handlers';
import type { ComponentGguiSession, JsonObject } from '@ggui-ai/protocol';
import {
  MCP_APP_AI_GGUI_VIEW_META_KEY,
  formatViewProofV1,
  viewProofArgsBytes,
  viewProofCallBytes,
  type McpAppsGguiSession,
  type ViewProofTool,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  assertViewProofDeclarations,
  createViewProofGate,
  runViewProofGate,
  unverifiableViewProofTools,
  type ViewProofGate,
} from './view-proof-gate.js';

const SECRET = 'gate-test-secret';
const NOW = Date.parse('2026-09-29T00:00:00.000Z');
const sessionId = 'render_gate_1';
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

type Declared = Pick<SharedHandler<ZodRawShape, ZodRawShape>, 'name' | 'viewProof'>;
const submit: Declared = {
  name: 'ggui_runtime_submit_action',
  viewProof: (input) => (input['kind'] === 'dispatch' ? 'required' : 'measured'),
};
const sync: Declared = { name: 'ggui_runtime_sync_context', viewProof: 'required' };
const pull: Declared = { name: 'ggui_runtime_pull', viewProof: 'measured' };

function card(overrides: Partial<ComponentGguiSession> = {}): ComponentGguiSession {
  return {
    type: 'component',
    id: sessionId,
    appId: 'app_1',
    componentCode: '/* card */',
    eventSequence: 0,
    createdAt: NOW - 60_000,
    lastActivityAt: 0,
    expiresAt: 0,
    epoch: 1,
    ...overrides,
  };
}

const dispatch: JsonObject = {
  kind: 'dispatch',
  payload: { intent: 'confirm', actionData: null, uiContext: {} },
  sessionId,
  appId: 'app_1',
  actionId: 'a3f2b1d4',
  firedAt: '2026-09-29T00:00:00.000Z',
};

/** A proof a view keyed for `sid` under the gate's secret would send for this call. */
function prove(opts: {
  sid?: string;
  appId?: string;
  toolName?: ViewProofTool;
  args?: JsonObject;
  flags?: string;
  vtime?: number;
  nonce?: string;
}): string {
  const root = mintViewRoot({ sessionId: opts.sid ?? sessionId, appId: opts.appId ?? 'app_1', src: 'result' }, SECRET);
  const P = root.token.split('.')[0] ?? '';
  const K = Buffer.from(root.viewKey ?? '', 'base64url');
  const toolName = opts.toolName ?? 'ggui_runtime_submit_action';
  const flags = opts.flags ?? '1';
  const nonce = opts.nonce ?? 'AAECAwQFBgcICQoLDA0ODw';
  const vtime = String(opts.vtime ?? NOW);
  const argmac = b64u(createHmac('sha256', K).update(viewProofArgsBytes(toolName, opts.args ?? dispatch)).digest());
  const callmac = b64u(createHmac('sha256', K).update(viewProofCallBytes({ toolName, nonce, vtime, flags, argmac })).digest());
  return formatViewProofV1({ root: P, nonce, vtime, flags, argmac, callmac });
}

const withProof = (proof: string): Readonly<Record<string, unknown>> => ({ [MCP_APP_AI_GGUI_VIEW_META_KEY]: proof });
const baseCtx: HandlerContext = { appId: 'app_1', requestId: 'req_1' };

function gateWith(store: InMemoryGguiSessionStore | undefined, keyedSince?: number, now = NOW): ViewProofGate {
  return createViewProofGate({
    secret: SECRET,
    sessionStore: store,
    ...(keyedSince !== undefined ? { keyedSince } : {}),
    now: () => now,
  });
}

describe('the measuring gate: declarations (ggui#1415)', () => {
  it('leaves a tool that declares no proof exactly as it came', async () => {
    const ctx = { ...baseCtx };
    const out = await runViewProofGate(gateWith(undefined), { name: 'ggui_render' }, {}, ctx);
    expect(out.ctx).toBe(ctx);
    expect(out.fields).toEqual({});
  });

  it('on a server with no verifier, a declared call is named unverifiable and nothing else', async () => {
    const out = await runViewProofGate(undefined, sync, { sessionId }, baseCtx);
    expect(out.fields).toEqual({ viewProofUnverifiable: true });
    expect(out.ctx.viewProof).toBeUndefined();
  });

  it('refuses at boot a declaration on a tool no view can sign, and names the declaring tools', () => {
    expect(() => assertViewProofDeclarations([submit, sync, pull, { name: 'ggui_render' }])).not.toThrow();
    expect(() => assertViewProofDeclarations([{ name: 'ggui_runtime_telemetry', viewProof: 'measured' }])).toThrow(
      /ggui_runtime_telemetry/,
    );
    expect(unverifiableViewProofTools([submit, sync, pull, { name: 'ggui_render' }])).toEqual([
      'ggui_runtime_submit_action',
      'ggui_runtime_sync_context',
      'ggui_runtime_pull',
    ]);
  });
});

describe('the measuring gate: a valid proof (ggui#1415)', () => {
  it('puts the verdict on the context and names the session, the root and the view clock on the line', async () => {
    const store = new InMemoryGguiSessionStore();
    const get = vi.spyOn(store, 'get');
    // The root is minted on the real clock; the gate's clock is set from it.
    const now = mintViewRoot({ sessionId, appId: 'app_1', src: 'result' }, SECRET).claims.iat * 1000 + 60_000;
    const ctx = { ...baseCtx, requestMeta: withProof(prove({ vtime: now - 45_000 })) };
    const out = await runViewProofGate(gateWith(store, undefined, now), submit, dispatch, ctx);
    expect(out.ctx.viewProof).toMatchObject({ verdict: 'valid', src: 'result', userActivation: true });
    expect(out.fields).toEqual({
      viewProof: 'valid',
      viewProofSessionId: sessionId,
      viewProofRootAge: 'lt_3m',
      viewProofRootSrc: 'result',
      viewProofSkew: 'behind_lt_5m',
      viewProofActivation: true,
    });
    // A valid proof classifies no era, so the gate reads no row.
    expect(get).not.toHaveBeenCalled();
  });

  it('marks a (session, nonce) pair this replica has seen, and reports activation only on a dispatch', async () => {
    const gate = gateWith(undefined);
    const args: JsonObject = { sessionId, snapshot: { draft: 'x' } };
    const ctx = { ...baseCtx, requestMeta: withProof(prove({ toolName: 'ggui_runtime_sync_context', args, flags: '0' })) };
    const first = await runViewProofGate(gate, sync, args, ctx);
    expect(first.fields).not.toHaveProperty('viewProofRepeat');
    expect(first.fields).not.toHaveProperty('viewProofActivation');
    const again = await runViewProofGate(gate, sync, args, ctx);
    expect(again.fields).toMatchObject({ viewProof: 'valid', viewProofRepeat: true });
  });

  it('buckets the root age and the skew on the server clock', async () => {
    const root = mintViewRoot({ sessionId, appId: 'app_1', src: 'result' }, SECRET);
    const iatMs = root.claims.iat * 1000;
    // Each edge, from both sides.
    const M = 60_000;
    const H = 3_600_000;
    const D = 86_400_000;
    const cases: Array<[number, string]> = [
      [iatMs, 'lt_3m'],
      [iatMs + 3 * M - 1, 'lt_3m'],
      [iatMs + 3 * M, 'lt_1h'],
      [iatMs + H - 1, 'lt_1h'],
      [iatMs + H, 'lt_1d'],
      [iatMs + D - 1, 'lt_1d'],
      [iatMs + D, 'lt_7d'],
      [iatMs + 7 * D - 1, 'lt_7d'],
      [iatMs + 7 * D, 'lt_30d'],
      [iatMs + 30 * D - 1, 'lt_30d'],
      [iatMs + 30 * D, 'ge_30d'],
    ];
    for (const [now, bucket] of cases) {
      const ctx = { ...baseCtx, requestMeta: withProof(prove({ vtime: now })) };
      const out = await runViewProofGate(gateWith(undefined, undefined, now), submit, dispatch, ctx);
      expect(out.fields.viewProofRootAge, bucket).toBe(bucket);
    }
    const skews: Array<[number, string]> = [
      [-3_600_000, 'behind_ge_1h'],
      [-3_600_000 + 1, 'behind_lt_1h'],
      [-5 * 60_000, 'behind_lt_1h'],
      [-5 * 60_000 + 1, 'behind_lt_5m'],
      [-30_000, 'behind_lt_5m'],
      [-30_000 + 1, 'within_30s'],
      [0, 'within_30s'],
      [30_000 - 1, 'within_30s'],
      [30_000, 'ahead_lt_5m'],
      [5 * 60_000 - 1, 'ahead_lt_5m'],
      [5 * 60_000, 'ahead_lt_1h'],
      [3_600_000 - 1, 'ahead_lt_1h'],
      [3_600_000, 'ahead_ge_1h'],
    ];
    for (const [delta, bucket] of skews) {
      const ctx = { ...baseCtx, requestMeta: withProof(prove({ vtime: NOW + delta })) };
      const out = await runViewProofGate(gateWith(undefined), submit, dispatch, ctx);
      expect(out.fields.viewProofSkew, bucket).toBe(bucket);
    }
  });
});

describe('the measuring gate: a call without a valid proof (ggui#1415)', () => {
  it('names the verdict and the claimed session; a measured call classifies no era and reads no row', async () => {
    const store = new InMemoryGguiSessionStore();
    const get = vi.spyOn(store, 'get');
    const out = await runViewProofGate(gateWith(store), pull, { sessionId }, baseCtx);
    expect(out.fields).toEqual({ viewProof: 'missing', viewProofReason: 'meta_absent', claimedSessionId: sessionId });
    expect(out.ctx.viewProof).toEqual({ verdict: 'missing', reason: 'meta_absent' });
    expect(get).not.toHaveBeenCalled();
  });

  it('names a verifier error with the class of what was thrown', async () => {
    const args = { ...dispatch, payload: { intent: 'confirm', actionData: { at: new Date(0) }, uiContext: {} } };
    const ctx = { ...baseCtx, requestMeta: withProof(prove({})) };
    const out = await runViewProofGate(gateWith(undefined), submit, args, ctx);
    expect(out.fields).toMatchObject({ viewProof: 'invalid', viewProofReason: 'verifier_error', viewProofErrorClass: 'TypeError' });
  });

  it('caps a claimed session id, and says so', async () => {
    const long = 's'.repeat(300);
    const out = await runViewProofGate(gateWith(undefined), pull, { sessionId: long }, baseCtx);
    expect(out.fields).toMatchObject({ claimedSessionId: 's'.repeat(128), claimedSessionIdTruncated: true });
  });

  it('classifies a required call’s session into its era, first match wins', async () => {
    const keyedSince = NOW - 3_600_000;
    const mcpApps = (createdAt: string): McpAppsGguiSession => ({
      type: 'mcpApps',
      id: sessionId,
      createdAt,
      source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' },
    });
    const cases: Array<[string, () => Promise<InMemoryGguiSessionStore | undefined>, number | undefined, string]> = [
      ['no store', async () => undefined, keyedSince, 'row_absent'],
      ['no row', async () => new InMemoryGguiSessionStore(), keyedSince, 'row_absent'],
      [
        'a failed read',
        async () => {
          const s = new InMemoryGguiSessionStore();
          vi.spyOn(s, 'get').mockRejectedValue(new Error('down'));
          return s;
        },
        keyedSince,
        'row_absent',
      ],
      [
        'another app’s row',
        async () => {
          const s = new InMemoryGguiSessionStore();
          await s.commit({ appId: 'app_other', render: card({ appId: 'app_other' }) });
          return s;
        },
        keyedSince,
        'foreign',
      ],
      [
        'keyedSince unset',
        async () => {
          const s = new InMemoryGguiSessionStore();
          await s.commit({ appId: 'app_1', render: card() });
          return s;
        },
        undefined,
        'legacy',
      ],
      [
        'created before keyedSince',
        async () => {
          const s = new InMemoryGguiSessionStore();
          await s.commit({ appId: 'app_1', render: card({ createdAt: keyedSince - 1 }) });
          return s;
        },
        keyedSince,
        'legacy',
      ],
      [
        'created at or after keyedSince',
        async () => {
          const s = new InMemoryGguiSessionStore();
          await s.commit({ appId: 'app_1', render: card({ createdAt: keyedSince }) });
          return s;
        },
        keyedSince,
        'current',
      ],
      [
        'an embedded MCP App created after keyedSince (an ISO creation time)',
        async () => {
          const s = new InMemoryGguiSessionStore();
          await s.commit({ appId: 'app_1', render: mcpApps(new Date(keyedSince + 1).toISOString()) });
          return s;
        },
        keyedSince,
        'current',
      ],
      [
        'an embedded MCP App created before keyedSince',
        async () => {
          const s = new InMemoryGguiSessionStore();
          await s.commit({ appId: 'app_1', render: mcpApps(new Date(keyedSince - 1).toISOString()) });
          return s;
        },
        keyedSince,
        'legacy',
      ],
      [
        'a creation time the server cannot read',
        async () => {
          const s = new InMemoryGguiSessionStore();
          await s.commit({ appId: 'app_1', render: mcpApps('not a date') });
          return s;
        },
        keyedSince,
        'legacy',
      ],
    ];
    for (const [label, makeStore, since, era] of cases) {
      const out = await runViewProofGate(gateWith(await makeStore(), since), sync, { sessionId }, baseCtx);
      expect(out.fields.viewProofEra, label).toBe(era);
    }
  });

  it('first match wins: another app’s row is foreign before it is unkeyed, and a long own row is unkeyed before it is legacy', async () => {
    const long = `render_${'x'.repeat(700)}`;
    const foreign = new InMemoryGguiSessionStore();
    await foreign.commit({ appId: 'app_other', render: card({ id: long, appId: 'app_other' }) });
    expect((await runViewProofGate(gateWith(foreign, NOW), sync, { sessionId: long }, baseCtx)).fields.viewProofEra).toBe('foreign');
    const own = new InMemoryGguiSessionStore();
    await own.commit({ appId: 'app_1', render: card({ id: long, createdAt: 0 }) });
    // keyedSince unset would read legacy; the long ids read unkeyed first.
    expect((await runViewProofGate(gateWith(own), sync, { sessionId: long }, baseCtx)).fields.viewProofEra).toBe('unkeyed');
  });

  it('reads a session whose ids are too long for a key as unkeyed', async () => {
    const long = `render_${'x'.repeat(700)}`;
    const store = new InMemoryGguiSessionStore();
    await store.commit({ appId: 'app_1', render: card({ id: long }) });
    const out = await runViewProofGate(gateWith(store, NOW - 3_600_000), sync, { sessionId: long }, baseCtx);
    expect(out.fields.viewProofEra).toBe('unkeyed');
  });

  it('reads the row through the request’s memo, so the handler’s own read costs nothing more', async () => {
    const store = new InMemoryGguiSessionStore();
    await store.commit({ appId: 'app_1', render: card() });
    const get = vi.spyOn(store, 'get');
    const out = await runViewProofGate(gateWith(store, NOW - 3_600_000), submit, dispatch, baseCtx);
    expect(out.fields.viewProofEra).toBe('current');
    const rows = out.ctx.sessionRows;
    expect(rows).toBeDefined();
    await rows?.read(store, sessionId);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
