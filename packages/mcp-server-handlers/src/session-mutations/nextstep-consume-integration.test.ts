/**
 * Phase 5.3 — end-to-end OSS integration test for the
 * push.nextStep → consume hint chain.
 *
 * Proves that the recovery-hint contract every push response carries
 * (`nextStep: ggui_consume({stackItemId})`) is observably correct:
 *
 *   1. `new_session` mints a fresh sessionId.
 *   2. `handshake({sessionId, intent, blueprintDraft})` returns a
 *      handshakeId + suggestion.
 *   3. `push({handshakeId, decision: {kind: 'accept'}})` with a
 *      non-empty actionSpec in the handshake's contract emits a
 *      `nextStep` field pointing at `ggui_consume` with the
 *      response's `stackItemId` as the args.
 *   4. Calling `consume({stackItemId})` with the EXACT id surfaced by
 *      step 3's nextStep returns a successful response — no events
 *      yet, status active, empty array.
 *
 * The whole chain runs end-to-end on real in-memory adapters in the
 * same process. No mocks. Catches future drift where any factory in
 * the chain breaks the nextStep contract — e.g. push emits the
 * wrong stackItemId, consume rejects the surfaced id, etc.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryKeyValueStore,
  InMemoryPendingEventConsumer,
  InMemorySessionStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiConsumeHandler } from './consume.js';
import { createGguiHandshakeHandler } from './handshake.js';
import { createGguiNewSessionHandler } from './new-session.js';
import { createGguiPushHandler } from './push.js';
import {
  createInMemoryProvisionalPreviewRegistry,
  type ProvisionalPreviewDeps,
} from './provisional-preview.js';

/**
 * Minimal provisionalPreview deps that trigger the push handler's
 * placeholder stack-item append. We don't care about preview frames
 * in this test — just that the stack item lands so consume's
 * stackItemId index lookup resolves.
 */
function makeMinimalPreviewDeps(): ProvisionalPreviewDeps {
  return {
    config: { enabled: true },
    emitter: { run: async () => undefined },
    sendEnvelope: async () => ({ seq: 1 }),
    registry: createInMemoryProvisionalPreviewRegistry(),
    onOutcome: () => undefined,
  };
}

const CTX = { appId: 'app-1', requestId: 'req-1' };

describe('Phase 5.3 — push.nextStep → consume integration', () => {
  it('full flow: new_session → handshake → push → consume(nextStep.args.stackItemId)', async () => {
    // ── Wiring ─────────────────────────────────────────────────────
    const sessionStore = new InMemorySessionStore();
    const kvStore = new InMemoryKeyValueStore();
    const pendingEventConsumer = new InMemoryPendingEventConsumer();

    const newSessionTool = createGguiNewSessionHandler({ sessionStore });
    const handshakeTool = createGguiHandshakeHandler({ kvStore });
    const pushTool = createGguiPushHandler({
      sessionStore,
      pendingEventConsumer,
      handshakeStore: kvStore,
      provisionalPreview: makeMinimalPreviewDeps(),
    });
    const consumeTool = createGguiConsumeHandler({
      pendingEventConsumer,
      sessionStore,
    });

    // ── 1. new_session ─────────────────────────────────────────────
    const newSession = (await newSessionTool.handler(
      { seed: 'phase-5-3-integration-seed' },
      CTX,
    )) as { sessionId: string };
    expect(newSession.sessionId).toBeTruthy();

    // Model C: push opens the pipe keyed by stackItemId. No need to
    // pre-register here — the push tool calls markCreated under the
    // hood the moment it mints stackItemId.

    // ── 2. handshake — supply the actionSpec-bearing contract on the
    //      blueprintDraft so the persisted effectiveContract carries
    //      it through to the paired push (accept-path uses the
    //      handshake's stored contract verbatim).
    const handshake = (await handshakeTool.handler(
      {
        sessionId: newSession.sessionId,
        intent: 'survey-form-with-submit-action',
        blueprintDraft: {
          contract: {
            actionSpec: {
              submit: {
                label: 'Submit',
              },
            },
          },
        },
      },
      CTX,
    )) as { handshakeId: string; contractHash: string };
    expect(handshake.handshakeId).toBeTruthy();

    // ── 3. push — accept the handshake suggestion; effectiveContract
    //      carries the actionSpec so nextStep MUST emit.
    const push = (await pushTool.handler(
      {
        handshakeId: handshake.handshakeId,
        decision: { kind: 'accept' },
      },
      CTX,
    )) as {
      stackItemId: string;
      nextStep?: {
        tool: string;
        args: { stackItemId: string };
      };
    };
    expect(push.stackItemId).toBeTruthy();
    expect(push.nextStep).toBeDefined();
    expect(push.nextStep?.tool).toBe('ggui_consume');
    // The contract-critical assertion: nextStep's stackItemId arg
    // MUST equal the response's stackItemId. Drift here would send
    // the agent calling consume with the wrong id.
    expect(push.nextStep?.args.stackItemId).toBe(push.stackItemId);

    // ── 4. consume — using the EXACT id push surfaced ──────────────
    const consumed = (await consumeTool.handler(
      { stackItemId: push.nextStep!.args.stackItemId, timeout: 0 },
      CTX,
    )) as { events: unknown[]; status: string };
    // No user interaction yet — events array empty, status active.
    // The point of the test is the chain works end-to-end, not the
    // event content.
    expect(consumed.events).toEqual([]);
    expect(consumed.status).toBe('active');
  });

  it('pure-display push (no actionSpec) emits NO nextStep — consume not needed', async () => {
    const sessionStore = new InMemorySessionStore();
    const kvStore = new InMemoryKeyValueStore();
    const newSessionTool = createGguiNewSessionHandler({ sessionStore });
    const handshakeTool = createGguiHandshakeHandler({ kvStore });
    const pushTool = createGguiPushHandler({
      sessionStore,
      handshakeStore: kvStore,
      provisionalPreview: makeMinimalPreviewDeps(),
    });
    const newSession = (await newSessionTool.handler(
      { seed: 'pure-display-seed' },
      CTX,
    )) as { sessionId: string };
    const handshake = (await handshakeTool.handler(
      {
        sessionId: newSession.sessionId,
        intent: 'static welcome banner',
        blueprintDraft: { contract: {} }, // no actionSpec
      },
      CTX,
    )) as { handshakeId: string };
    const push = (await pushTool.handler(
      {
        handshakeId: handshake.handshakeId,
        decision: { kind: 'accept' },
      },
      CTX,
    )) as { stackItemId: string; nextStep?: unknown };
    expect(push.stackItemId).toBeTruthy();
    // Pure display = no consume needed = no nextStep.
    expect(push.nextStep).toBeUndefined();
  });
});
