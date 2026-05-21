/**
 * Tier 2 wired-action bridge: prove the host simulator drives the
 * empirically-validated 3-message dance documented at
 * `docs/development/mcp-apps-wired-actions.md` end-to-end.
 *
 * What this asserts (per documented bridge contract):
 *   1. The shared FNV-1a 8-hex actionId binds all three envelopes —
 *      consent text + pending-action JSON contain the same id.
 *   2. The gateway `tools/call ggui_runtime_submit_action` actually
 *      round-trips to the server, which validates the envelope and
 *      returns the `{ok:true}` ack.
 *   3. `ui/update-model-context` carries `[ggui:pending-action] {...}`
 *      with the EXACT structured args (no natural-language paraphrase,
 *      which would defeat the bridge's whole point).
 *   4. The consent prompt embeds intent + inline data + actionId so
 *      the user can see what they're authorizing.
 *   5. Latest-wins overwrite (spec §1099): a second wired action
 *      replaces the model context but stacks the consent log.
 *
 * If any of these break, real claude.ai traffic against the server
 * silently mis-handles button clicks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  HostSimulator,
  bootOssServer,
  buildWiredAction,
  wiredActionFnv1a,
  type OssFixture,
} from '../src/index.js';

describe('host-simulator: wired-action bridge', () => {
  let fixture: OssFixture | null = null;
  let host: HostSimulator | null = null;

  afterEach(async () => {
    if (host) {
      await host.close();
      host = null;
    }
    if (fixture) {
      await fixture.close();
      fixture = null;
    }
  });

  it('fnv1a hash matches runtime.ts byte-for-byte', () => {
    // Spot-check against a known input/output pair so future drift in
    // either side fails loudly here. The hash is fed `intent | JSON |
    // firedAt` — pinning a deterministic case.
    expect(wiredActionFnv1a('submit|null|2026-05-04T10:00:00.000Z')).toMatch(
      /^[0-9a-f]{8}$/,
    );
    expect(wiredActionFnv1a('a')).toBe('e40c292c');
    expect(wiredActionFnv1a('')).toBe('811c9dc5');
  });

  it('builds 3 envelopes with shared actionId + correct shape', () => {
    const built = buildWiredAction({
      intent: 'createEvent',
      data: { title: 'Team sync', when: '2026-05-04T15:00' },
      sessionId: 'sess_abc',
      appId: 'app_xyz',
      firedAt: '2026-05-04T12:00:00.000Z',
      idSeed: [1, 2, 3],
    });

    // All three carry the same actionId.
    expect(built.toolsCall.params.arguments.actionId).toBe(built.actionId);
    expect(built.pendingActionText).toContain(`"actionId":"${built.actionId}"`);
    expect(built.consentText).toContain(`[id: \`${built.actionId}\`]`);

    // Tools-call envelope shape: `SubmitActionEnvelope` per
    // `@ggui-ai/protocol/integrations/mcp-apps`. Tool is
    // `ggui_runtime_submit_action`; the dispatch payload is
    // `{intent, actionData, uiContext}` + ambient correlation fields.
    expect(built.toolsCall.method).toBe('tools/call');
    expect(built.toolsCall.params.name).toBe('ggui_runtime_submit_action');
    expect(built.toolsCall.params.arguments).toMatchObject({
      kind: 'dispatch',
      payload: {
        intent: 'createEvent',
        actionData: { title: 'Team sync', when: '2026-05-04T15:00' },
        uiContext: {},
      },
      sessionId: 'sess_abc',
      appId: 'app_xyz',
      firedAt: '2026-05-04T12:00:00.000Z',
    });

    // Update-model-context: content MUST be array per claude.ai's
    // validator (the spec example's single-object shape is rejected).
    expect(built.updateContext.method).toBe('ui/update-model-context');
    expect(Array.isArray(built.updateContext.params.content)).toBe(true);
    expect(built.updateContext.params.content[0]?.type).toBe('text');

    // ui/message: role:user, content array, intent + inline data.
    expect(built.uiMessage.method).toBe('ui/message');
    expect(built.uiMessage.params.role).toBe('user');
    expect(Array.isArray(built.uiMessage.params.content)).toBe(true);
    expect(built.consentText).toContain('**createEvent**');
    expect(built.consentText).toContain('title: Team sync');
  });

  it('happy path: simulateWiredAction round-trips gateway, captures host envelopes', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({
      url: fixture.url,
      bearer: 'host-simulator-test',
    });
    await host.connect();

    // Mint a real bootstrap — the wired-action needs a sessionId/appId
    // pair from a `ggui_push` to be wire-faithful. Use the canonical
    // new_session → handshake → push flow.
    const flow = await host.openSession({
      intent: 'render a hello world card',
      blueprintDraft: {
        contract: {
          contextSpec: {
            name: { schema: { type: 'string' }, default: '' },
          },
        },
      },
    });
    expect(
      flow.push.bootstrap,
      'bootstrap is required for the wired action',
    ).toBeDefined();
    const bootstrap = flow.push.bootstrap!;

    const result = await host.simulateWiredAction({
      intent: 'submit',
      data: { name: 'Wanseob', tier: 'pro' },
      bootstrap,
    });

    // (1) actionId is 8 hex chars.
    expect(result.actionId).toMatch(/^[0-9a-f]{8}$/);

    // (2) gateway round-trip: `ggui_runtime_submit_action` validates
    // the envelope and appends it to the stackItem-keyed pending-events
    // pipe, returning the minimal `{ok, consumerPresent?}` ack (the
    // verbatim-echo handler was retired with the submit_action rename).
    expect(result.gatewayResult).toMatchObject({ ok: true });

    // (3) Pending-action context carries EXACT structured args (no
    // paraphrase). actionId in the JSON line MUST match the consent's.
    expect(result.pendingActionText).toMatch(/^\[ggui:pending-action\] /);
    expect(result.pendingActionText).toContain(`"actionId":"${result.actionId}"`);
    expect(result.pendingActionText).toContain('"intent":"submit"');
    expect(result.pendingActionText).toContain('"name":"Wanseob"');
    expect(result.pendingActionText).toContain(`"sessionId":"${bootstrap.sessionId}"`);
    expect(result.pendingActionText).toContain(`"appId":"${bootstrap.appId}"`);

    // (4) Consent prompt has the human-readable summary + actionId stamp.
    expect(result.consentText).toContain('**submit**');
    expect(result.consentText).toContain('name: Wanseob');
    expect(result.consentText).toContain('tier: pro');
    expect(result.consentText).toContain(`[id: \`${result.actionId}\`]`);

    // Captured envelopes are also addressable on the simulator state.
    expect(host.getModelContext()).toBe(result.pendingActionContext);
    expect(host.getConsentLog()).toHaveLength(1);
    expect(host.getConsentLog()[0]).toBe(result.consentMessage);
  });

  it('latest-wins overwrite: second click replaces context, stacks consent log', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({
      url: fixture.url,
      bearer: 'host-simulator-test',
    });
    await host.connect();

    const flow = await host.openSession({
      intent: 'render a counter',
      blueprintDraft: {
        contract: {
          contextSpec: {
            count: { schema: { type: 'number' }, default: 0 },
          },
        },
      },
    });
    const bootstrap = flow.push.bootstrap!;

    const first = await host.simulateWiredAction({
      intent: 'increment',
      data: { by: 1 },
      bootstrap,
    });
    const second = await host.simulateWiredAction({
      intent: 'reset',
      data: null,
      bootstrap,
    });

    // Different actionIds — different intent + data + firedAt.
    expect(first.actionId).not.toBe(second.actionId);

    // Latest-wins: model context now reflects the SECOND action.
    const ctx = host.getModelContext();
    expect(ctx, 'modelContext after 2 dispatches').not.toBeNull();
    expect(ctx?.params.content[0]?.text).toContain(`"actionId":"${second.actionId}"`);
    expect(ctx?.params.content[0]?.text).toContain('"intent":"reset"');

    // Consent log STACKS (the user has to send each one separately).
    const log = host.getConsentLog();
    expect(log).toHaveLength(2);
    expect(log[0]?.params.content[0]?.text).toContain(`[id: \`${first.actionId}\`]`);
    expect(log[1]?.params.content[0]?.text).toContain(`[id: \`${second.actionId}\`]`);
  });
});
