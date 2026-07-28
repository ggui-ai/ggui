/**
 * Unit tests for the `/control` plane composition — the audience
 * projection, the per-tool wrappers, and the assembled service shape.
 * Pure: no transport, no adapters. Wire-level behavior (the mounted
 * route, the reject-federated gate, anonymous reads) is covered in
 * `mcp-endpoint-routes.test.ts` + `server.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AuthRequiredError,
  type HandlerContext,
  type SharedHandler,
} from '@ggui-ai/mcp-server-handlers';
import {
  buildControlService,
  CONTROL_PATH,
  filterHandlersByAudience,
  SINGLE_CALL_OPS,
  stripAudience,
  withAuthGate,
  withConfirmGate,
  type AudienceTag,
} from './control-service.js';
import { validateServiceHandlers } from './mcp-mounts.js';

/** No credential the auth adapter accepted — the anonymous synthetic. */
const ctxAnon: HandlerContext = {
  appId: 'builder',
  requestId: 'r-anon',
  authSource: 'anonymous',
};
/** A single-user OSS builder — authenticated, but carries no identity fields. */
const ctxBuilder: HandlerContext = {
  appId: 'builder',
  requestId: 'r-dev',
  authSource: 'dev',
};
/** A hosted per-user caller. */
const ctxUser: HandlerContext = {
  appId: 'app1',
  requestId: 'r-user',
  authSource: 'apikey',
  userId: 'user-123',
};

/** A minimal, well-formed SharedHandler with a declared output field. */
function fakeHandler(
  name: string,
  audience?: ReadonlyArray<AudienceTag>,
): SharedHandler<{ x: z.ZodString }, { ok: z.ZodBoolean }, { ok: boolean }> {
  return {
    name,
    description: `fake ${name}`,
    ...(audience ? { audience } : {}),
    inputSchema: { x: z.string() },
    outputSchema: { ok: z.boolean() },
    async handler() {
      return { ok: true };
    },
  };
}

describe('filterHandlersByAudience', () => {
  const set = [
    fakeHandler('ggui_search_blueprints'), // untagged → agent
    fakeHandler('ggui_runtime_submit_action', ['runtime']),
    fakeHandler('ggui_protocol_validate_blueprint', ['protocol']),
    fakeHandler('ggui_ops_list_apps', ['ops']),
  ];

  it('treats an untagged handler as agent-callable', () => {
    const names = filterHandlersByAudience(set, ['agent']).map((h) => h.name);
    expect(names).toEqual(['ggui_search_blueprints']);
  });

  it('splits the two planes with no overlap and no orphans', () => {
    const dataPlane = filterHandlersByAudience(set, ['agent', 'runtime']).map((h) => h.name);
    const controlPlane = filterHandlersByAudience(set, ['protocol', 'ops']).map((h) => h.name);
    expect(dataPlane).toEqual(['ggui_search_blueprints', 'ggui_runtime_submit_action']);
    expect(controlPlane).toEqual([
      'ggui_protocol_validate_blueprint',
      'ggui_ops_list_apps',
    ]);
    // Every handler lands on exactly one plane.
    expect(dataPlane.length + controlPlane.length).toBe(set.length);
    expect(dataPlane.filter((n) => controlPlane.includes(n))).toEqual([]);
  });
});

describe('stripAudience', () => {
  it('removes the audience field so a control handler passes service validation', () => {
    const out = stripAudience(fakeHandler('ggui_protocol_validate_blueprint', ['protocol']));
    expect(out.audience).toBeUndefined();
    expect('audience' in out).toBe(false);
    expect(out.name).toBe('ggui_protocol_validate_blueprint');
    expect(out.outputSchema).toHaveProperty('ok');
  });
});

describe('withAuthGate', () => {
  it('throws AuthRequiredError for the anonymous synthetic', async () => {
    const gated = withAuthGate(fakeHandler('ggui_ops_list_apps', ['ops']));
    await expect(gated.handler({ x: 'a' }, ctxAnon)).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('throws AuthRequiredError when no auth ran at all (in-process invocation)', async () => {
    const gated = withAuthGate(fakeHandler('ggui_ops_list_apps', ['ops']));
    const ctxNone: HandlerContext = { appId: 'builder', requestId: 'r-none' };
    await expect(gated.handler({ x: 'a' }, ctxNone)).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('admits an authenticated single-user builder (no userId, no apiKeyHash)', async () => {
    // The regression this pins: gating on identity FIELDS would reject
    // every OSS deployment, whose authenticated identity collapses to
    // `{kind:'builder'}` and carries neither field.
    const gated = withAuthGate(fakeHandler('ggui_ops_list_apps', ['ops']));
    await expect(gated.handler({ x: 'a' }, ctxBuilder)).resolves.toEqual({ ok: true });
  });

  it('admits an authenticated per-user caller', async () => {
    const gated = withAuthGate(fakeHandler('ggui_ops_list_apps', ['ops']));
    await expect(gated.handler({ x: 'a' }, ctxUser)).resolves.toEqual({ ok: true });
  });

  it('preserves the inner input/output schemas', () => {
    const gated = withAuthGate(fakeHandler('ggui_ops_list_apps', ['ops']));
    expect(gated.inputSchema).toHaveProperty('x');
    expect(gated.outputSchema).toHaveProperty('ok');
  });
});

describe('withConfirmGate', () => {
  it('returns confirmationRequired on the first call and does NOT run the inner handler', async () => {
    let ran = false;
    const inner: SharedHandler<{ x: z.ZodString }, { ok: z.ZodBoolean }, { ok: boolean }> = {
      ...fakeHandler('ggui_ops_delete_app', ['ops']),
      async handler() {
        ran = true;
        return { ok: true };
      },
    };
    const gated = withConfirmGate(inner);
    const res = (await gated.handler({ x: 'a' }, ctxUser)) as { confirmationRequired?: boolean };
    expect(res.confirmationRequired).toBe(true);
    expect(ran).toBe(false);
  });

  it('delegates (stripping confirm) when confirm:true', async () => {
    const gated = withConfirmGate(fakeHandler('ggui_ops_delete_app', ['ops']));
    await expect(gated.handler({ x: 'a', confirm: true }, ctxUser)).resolves.toEqual({ ok: true });
  });

  it('adds a confirm input field and an output schema admitting both shapes', () => {
    const gated = withConfirmGate(fakeHandler('ggui_ops_delete_app', ['ops']));
    expect(gated.inputSchema).toHaveProperty('confirm');
    expect(gated.outputSchema).toHaveProperty('confirmationRequired');
    // Inner fields survive (optionalized) so a real commit response still validates.
    expect(gated.outputSchema).toHaveProperty('ok');
  });
});

describe('buildControlService', () => {
  const handlers = [
    // data plane — must NOT appear
    fakeHandler('ggui_search_blueprints'),
    fakeHandler('ggui_runtime_submit_action', ['runtime']),
    // control plane
    fakeHandler('ggui_protocol_validate_blueprint', ['protocol']),
    fakeHandler('ggui_ops_list_apps', ['ops']), // known read
    fakeHandler('ggui_ops_delete_app', ['ops']), // known mutation
    fakeHandler('ggui_ops_do_something_new', ['ops']), // unclassified
  ];
  const svc = buildControlService({ handlers });
  const byName = new Map(svc.handlers.map((h) => [h.name, h]));

  it('mounts at /control, anonymous', () => {
    expect(svc.path).toBe(CONTROL_PATH);
    expect(svc.path).toBe('/control');
    expect(svc.anonymous).toBe(true);
  });

  it('carries the protocol + ops tools and nothing from the data plane', () => {
    const names = [...byName.keys()].sort();
    expect(names).toEqual([
      'ggui_ops_delete_app',
      'ggui_ops_do_something_new',
      'ggui_ops_list_apps',
      'ggui_protocol_validate_blueprint',
    ]);
  });

  it('passes the same handler invariants an operator-supplied service must', () => {
    expect(() => validateServiceHandlers(svc)).not.toThrow();
  });

  it('leaves protocol tools anonymous but auth-gates every ops tool', async () => {
    const protocol = byName.get('ggui_protocol_validate_blueprint')!;
    await expect(protocol.handler({ x: 'a' }, ctxAnon)).resolves.toEqual({ ok: true });

    for (const opsName of ['ggui_ops_list_apps', 'ggui_ops_delete_app']) {
      await expect(
        byName.get(opsName)!.handler({ x: 'a' }, ctxAnon),
      ).rejects.toBeInstanceOf(AuthRequiredError);
    }
  });

  it('auth-gates BEFORE the confirm gate (anon gets an auth error, not a preview)', async () => {
    const mut = byName.get('ggui_ops_delete_app')!;
    await expect(mut.handler({ x: 'a' }, ctxAnon)).rejects.toBeInstanceOf(AuthRequiredError);
    const preview = (await mut.handler({ x: 'a' }, ctxUser)) as {
      confirmationRequired?: boolean;
    };
    expect(preview.confirmationRequired).toBe(true);
  });

  it('leaves known reads single-call', () => {
    expect(byName.get('ggui_ops_list_apps')!.inputSchema).not.toHaveProperty('confirm');
  });

  it('confirm-gates an unclassified ops tool (default-deny)', () => {
    // The point of inverting the list: a state-changing tool nobody
    // classified must not ship un-gated.
    expect(byName.get('ggui_ops_do_something_new')!.inputSchema).toHaveProperty('confirm');
  });

  it('honors singleCallOps for a deployment-registered read', async () => {
    const custom = buildControlService({
      handlers,
      singleCallOps: ['ggui_ops_do_something_new'],
    });
    const h = custom.handlers.find((x) => x.name === 'ggui_ops_do_something_new')!;
    expect(h.inputSchema).not.toHaveProperty('confirm');
    // Still auth-gated — singleCallOps only waives the confirmation.
    await expect(h.handler({ x: 'a' }, ctxAnon)).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('SINGLE_CALL_OPS', () => {
  it('lists the read/list ops that must stay single-call', () => {
    for (const n of [
      'ggui_ops_list_apps',
      'ggui_ops_list_orgs',
      'ggui_ops_list_connector_keys',
      'ggui_ops_get_credit_balance',
      'ggui_ops_list_blueprints',
      // setup_byok opens/lists the BYOK card (a read); set/remove are
      // separate tools. Confirm-gating it would break the card's inline
      // render — the preview shape lacks the card's discriminant.
      'ggui_ops_setup_byok',
    ]) {
      expect(SINGLE_CALL_OPS.has(n), `${n} must be single-call`).toBe(true);
    }
  });

  it('excludes every state-changing op', () => {
    for (const n of [
      'ggui_ops_create_app',
      'ggui_ops_delete_app',
      'ggui_ops_issue_connector_key',
      'ggui_ops_redeem_coupon',
      'ggui_ops_set_provider_key',
      'ggui_ops_invite_to_org',
      'ggui_ops_register_blueprint',
      'ggui_ops_delete_blueprint',
      // open_app writes the account-wide default app — a state change
      // despite the "open" name, the same mutation as set_default_app.
      'ggui_ops_open_app',
    ]) {
      expect(SINGLE_CALL_OPS.has(n), `${n} must be confirm-gated`).toBe(false);
    }
  });
});
