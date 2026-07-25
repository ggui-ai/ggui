/**
 * Layer-B guest-gesture transcript — the ggui-AUTHORED fixture from the
 * Phase 4 three-repo e2e negotiation (issue #360, cassette consumption).
 *
 * Plan ref: `docs/plans/2026-07-22-e2e-rearchitecture-three-repo.md`,
 * "Negotiated outcome" item 2 (2026-07-24 ruling → silverprotocol
 * counter → accepted 2026-07-25; threads silverprotocol/workspace#1 →
 * accepted work in silverprotocol/workspace#2). silverprotocol bounced
 * the guest-gesture capture: gestures never appear on any framework's
 * server-side stream — client→host interaction semantics are Layer-B,
 * ggui's layer. So ggui authors the transcript. THIS file is the
 * authoritative record of what a guest UI gesture becomes on ggui's
 * wire; a future capture-for-silverprotocol reads its canonical source
 * here. No corpus cassette and no @silverprotocol/core involved — the
 * test IS the fixture.
 *
 * The transcript (in-process `createGguiServer`, keyless):
 *
 *   ggui_render                    — mints sessionId, opens the
 *                                    pending-events pipe (markCreated)
 *   ggui_runtime_submit_action     — {kind:'dispatch', payload:{intent,
 *                                    actionData, uiContext}, sessionId,
 *                                    appId, actionId, firedAt}
 *                                  → {ok:true, consumerPresent}
 *   ggui_consume                   — {sessionId, timeout}
 *                                  → {events:[{type:'action', sessionId,
 *                                    intent, actionData, uiContext,
 *                                    actionId, firedAt}], status}
 *
 * The load-bearing assertion is submit↔drain correlation: the 8-hex
 * FNV-1a `actionId` minted at gesture time is the id on the drained
 * consume event. Negative arms pin the two degradation shapes the
 * handlers define (`oss/packages/mcp-server-handlers/src/renders/
 * {submit-action,consume}.ts`):
 *
 *   - dispatch onto a sessionId whose pipe never opened →
 *     `{ok:false, code:'PIPE_NOT_FOUND', message}` (iframe-runtime
 *     falls through to the `ui/message` chat-shortcut);
 *   - dispatch with no in-flight `ggui_consume` long-poll →
 *     `{ok:true, consumerPresent:false}` AND the gesture HELD on the
 *     pipe (queued-doorbell semantics: the iframe rings the
 *     `ai.ggui/userAction` doorbell host-side; the server-observable
 *     contract is accept + queue + FIFO drain on the next consume).
 *
 * Assertion discipline mirrors the FIXTURES.md stability contract:
 * event types, ordering, tool names, structural shape, and correlation
 * ids this transcript minted itself. Never prose — rejection `message`
 * is asserted present and typed, not matched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GguiConsumeOutput } from '@ggui-ai/protocol';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  HostSimulator,
  bootOssServer,
  type OssFixture,
} from '../src/index.js';

/**
 * Structural mirror of `ggui_runtime_submit_action`'s output union
 * (`UserActionAccepted | UserActionRejected` in
 * `mcp-server-handlers/src/renders/submit-action.ts` — not exported).
 * Mirrored in-file the same way `host-simulator.ts` mirrors handshake
 * shapes, so this e2e package doesn't grow a deep-internal import and
 * the transcript documents the wire shape it asserts.
 */
interface SubmitActionAck {
  readonly ok: boolean;
  /** Canonical rejection code — present only on `ok:false`. */
  readonly code?: 'INVALID_ACTION_KIND' | 'PIPE_NOT_FOUND';
  /** Diagnostic prose on `ok:false` — asserted present, never matched. */
  readonly message?: string;
  /**
   * On `ok:true` dispatch: whether a `ggui_consume` long-poll is
   * registered for the targeted render. The OSS server always wires
   * the in-memory active-consumer registry, so the field is a real
   * boolean on every accepted dispatch (never omitted here).
   */
  readonly consumerPresent?: boolean;
}

/** All helpers stay in-file (test-placement rule — no shared fixtures). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Canonical `handshake → render` boot — returns the bootstrap meta the
 * guest gesture targets (sessionId + appId), exactly how a real host
 * obtains them before the iframe can fire a gesture.
 *
 * Uses the `[ggui:probe]` system-card intent DELIBERATELY: on a keyless
 * boot (no UiGenerator wired) a plain intent mints the bootstrap and
 * opens the pending-events pipe but never COMMITS a GguiSession row, so
 * `ggui_consume`'s tenancy gate (`renderStore.get` + `isVisibleToCaller`)
 * rejects with session-not-found even though `ggui_runtime_submit_action`
 * happily appends to the pipe. The probe short-circuit in
 * `mcp-server-handlers/src/renders/render.ts` is the deterministic
 * in-tree render path that commits keylessly (a `SystemGguiSession`),
 * giving the drain half a resolvable session without any LLM call.
 */
async function openGuestSession(
  host: HostSimulator,
): Promise<McpAppAiGguiRenderMeta> {
  const flow = await host.openRender({
    intent: '[ggui:probe] guest-gesture transcript surface',
    blueprintDraft: {
      contract: {
        contextSpec: {
          draft: { schema: { type: 'string' }, default: '' },
        },
      },
    },
  });
  expect(
    flow.render.meta,
    'bootstrap meta is required — the gesture transcript is keyed by sessionId/appId',
  ).toBeDefined();
  return flow.render.meta!;
}

describe('guest-gesture transcript (Layer-B, ggui-authored)', () => {
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

  it('round trip: dispatch → {ok, consumerPresent:true} → consume drains the event; actionId binds submit↔drain', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({
      url: fixture.url,
      bearer: 'host-simulator-test',
    });
    await host.connect();

    // The drain half must be advertised to agents on /mcp — the
    // consume hint chain (`nextStep.tool === "ggui_consume"`) is dead
    // wire if the tool name ever drifts.
    const tools = await host.listTools();
    expect(tools.map((t) => t.name)).toContain('ggui_consume');

    const bootstrap = await openGuestSession(host);

    // Start the agent's long-poll BEFORE the gesture, so the
    // active-consumer registry observes a live consumer (this is the
    // healthy-loop arm: agent listening, user clicks). The handler
    // enters the registry synchronously at the top of the long-poll;
    // the sleep only covers the local HTTP hop.
    const consumePromise = host.callTool('ggui_consume', {
      sessionId: bootstrap.sessionId,
      timeout: 15,
    });
    await sleep(750);

    const submitted = await host.simulateSubmitAction({
      intent: 'createEvent',
      data: { title: 'Team sync', when: '2026-07-25T15:00' },
      meta: bootstrap,
    });

    // Gateway ack: envelope validated, appended to the sessionId-keyed
    // pipe, and a consumer IS registered (the long-poll above).
    const ack = submitted.gatewayResult as SubmitActionAck;
    expect(ack.ok).toBe(true);
    expect(ack.code).toBeUndefined();
    expect(ack.consumerPresent).toBe(true);

    // The in-flight consume unblocks with the gesture.
    const consumed = await consumePromise;
    expect(consumed.isError).toBeUndefined();
    const output = consumed.structuredContent as GguiConsumeOutput;
    expect(output.status).toBe('active');
    expect(output.events).toHaveLength(1);

    // Full ConsumeEventEntry shape — the per-gesture entry the agent
    // reads: actionData is WHAT the user did; uiContext is the
    // contextSpec snapshot at gesture time (the simulator dispatches
    // with an empty snapshot).
    expect(output.events[0]).toMatchObject({
      type: 'action',
      sessionId: bootstrap.sessionId,
      intent: 'createEvent',
      actionData: { title: 'Team sync', when: '2026-07-25T15:00' },
      uiContext: {},
      firedAt: submitted.firedAt,
    });

    // THE load-bearing correlation: the 8-hex FNV-1a id minted at
    // gesture time is byte-identical on the drained event. This is
    // what lets the iframe's toast, the host LLM's consent
    // cross-check, and the server's drain_ack all speak about the
    // same gesture.
    expect(submitted.actionId).toMatch(/^[0-9a-f]{8}$/);
    expect(output.events[0]?.actionId).toBe(submitted.actionId);
  });

  it('queued doorbell: no consumer in flight → consumerPresent:false; gestures hold on the pipe and drain FIFO exactly once', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({
      url: fixture.url,
      bearer: 'host-simulator-test',
    });
    await host.connect();
    const bootstrap = await openGuestSession(host);

    // Two gestures BEFORE any ggui_consume long-poll exists. Server
    // contract per submit-action.ts: the envelope is ACCEPTED (the
    // pipe was opened at render time, so the click is never lost) and
    // `consumerPresent:false` tells the iframe to ring the
    // `ai.ggui/userAction` doorbell on a `ui/message` — a host-side
    // effect outside this wire; what IS server-observable is
    // accept + queue.
    const first = await host.simulateSubmitAction({
      intent: 'increment',
      data: { by: 1 },
      meta: bootstrap,
    });
    const second = await host.simulateSubmitAction({
      intent: 'reset',
      data: null,
      meta: bootstrap,
    });
    expect(first.gatewayResult as SubmitActionAck).toMatchObject({
      ok: true,
      consumerPresent: false,
    });
    expect(second.gatewayResult as SubmitActionAck).toMatchObject({
      ok: true,
      consumerPresent: false,
    });
    expect(first.actionId).not.toBe(second.actionId);

    // The queued gestures drain FIFO on the next consume — timeout:0
    // is the immediate fetch-and-clear (no long-poll needed; the
    // events are already buffered).
    const drained = await host.callTool('ggui_consume', {
      sessionId: bootstrap.sessionId,
      timeout: 0,
    });
    const output = drained.structuredContent as GguiConsumeOutput;
    expect(output.status).toBe('active');
    expect(output.events.map((e) => e.type)).toEqual(['action', 'action']);
    expect(output.events.map((e) => e.intent)).toEqual([
      'increment',
      'reset',
    ]);
    expect(output.events.map((e) => e.actionId)).toEqual([
      first.actionId,
      second.actionId,
    ]);
    // Bare-click gesture (data:null) drains as actionData:null — the
    // canonical no-payload shape, not `{}` and not absent.
    expect(output.events[1]?.actionData).toBeNull();

    // Fetch-and-clear semantics: a second drain is empty — each
    // gesture is delivered to the agent exactly once.
    const redrained = await host.callTool('ggui_consume', {
      sessionId: bootstrap.sessionId,
      timeout: 0,
    });
    const reOutput = redrained.structuredContent as GguiConsumeOutput;
    expect(reOutput.events).toEqual([]);
    expect(reOutput.status).toBe('active');
  });

  it('PIPE_NOT_FOUND: dispatch onto a sessionId whose pipe never opened rejects with the canonical code (no silent drop)', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({
      url: fixture.url,
      bearer: 'host-simulator-test',
    });
    await host.connect();

    // A real render supplies a well-formed bootstrap; the ghost meta
    // retargets the gesture at a sessionId that never rendered — the
    // closed/never-opened-pipe arm the iframe-runtime branches on to
    // fall through to `ui/message`.
    const bootstrap = await openGuestSession(host);
    const ghostMeta: McpAppAiGguiRenderMeta = {
      ...bootstrap,
      sessionId: 'rnd_never_rendered_ghost',
    };

    const submitted = await host.simulateSubmitAction({
      intent: 'submit',
      data: { answer: 'yes' },
      meta: ghostMeta,
    });
    const ack = submitted.gatewayResult as SubmitActionAck;
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('PIPE_NOT_FOUND');
    // Diagnostic message: structural presence only — prose is
    // explicitly non-normative.
    expect(typeof ack.message).toBe('string');
    expect(ack.message?.length).toBeGreaterThan(0);
    // No append happened → no consumer signal on the rejection shape.
    expect(ack.consumerPresent).toBeUndefined();

    // The real session's pipe is untouched by the misdirected gesture:
    // an immediate drain is empty and the session is still active.
    const drained = await host.callTool('ggui_consume', {
      sessionId: bootstrap.sessionId,
      timeout: 0,
    });
    const output = drained.structuredContent as GguiConsumeOutput;
    expect(output.events).toEqual([]);
    expect(output.status).toBe('active');
  });
});
