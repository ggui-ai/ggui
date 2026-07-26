/**
 * Regression contract for ggui#365 — a keyless PLAIN render must commit a
 * session row.
 *
 * The bug: on a keyless `bootOssServer` (no UiGenerator), `ggui_render`
 * minted a sessionId and called `markCreated(sessionId)` — opening the
 * pending-events pipe — but committed NO row, because the handler's
 * `if (probe) … else if (generation) …` chain had no `else`. The result was
 * a live asymmetry on one id:
 *
 *   ggui_render                   → returns sessionId
 *   ggui_runtime_submit_action    → ACCEPTS gestures onto it (pipe is open)
 *   ggui_consume / get_session    → REJECT it (tenancy gate reads
 *                                   renderStore.get, and no row exists)
 *
 * i.e. gestures accepted into a pipe no consumer could ever drain, and a
 * sessionId the server handed out but would not admit existed.
 *
 * These tests use a PLAIN intent deliberately. The sibling
 * `guest-gesture.contract.test.ts` works around the bug with the
 * `[ggui:probe]` short-circuit (the one keyless path that always
 * committed) — so it cannot catch a regression here. If the `else` branch
 * in `mcp-server-handlers/src/renders/render.ts` is removed, the first
 * test below fails on session-not-found.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HostSimulator, bootOssServer, type OssFixture } from '../src/index.js';

/** A plain intent — no `[ggui:probe]` prefix, so no short-circuit commit. */
const PLAIN_INTENT = 'a keyless surface with no generator wired';

describe('keyless plain render commits a session row (ggui#365)', () => {
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

  it('ggui_get_session resolves the id ggui_render just returned', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({ url: fixture.url });
    await host.connect();

    const flow = await host.openRender({
      intent: PLAIN_INTENT,
      blueprintDraft: {
        contract: {
          contextSpec: { draft: { schema: { type: 'string' }, default: '' } },
        },
      },
    });
    const sessionId = flow.render.meta?.sessionId;
    expect(sessionId, 'render must mint a sessionId').toBeTruthy();

    // THE regression assertion. Pre-fix this rejected with
    // session-not-found — the server disowning an id it had just issued.
    const session = await host.callTool('ggui_get_session', { sessionId });
    expect(
      session.isError ?? false,
      `ggui_get_session rejected the sessionId ggui_render returned: ${JSON.stringify(session)}`,
    ).toBe(false);

    // NOTE: deliberately no `codeReady` assertion here — that field is
    // zod-stripped from the wire by `renderOutputSchema`, so reading it
    // off the meta is a type error and asserting it would be testing a
    // field the protocol does not ship.
  });

  it('a gesture submitted onto a keyless render is drainable by ggui_consume', async () => {
    fixture = await bootOssServer();
    host = new HostSimulator({ url: fixture.url });
    await host.connect();

    const flow = await host.openRender({
      intent: PLAIN_INTENT,
      blueprintDraft: {
        contract: {
          contextSpec: { draft: { schema: { type: 'string' }, default: '' } },
        },
      },
    });
    const meta = flow.render.meta;
    expect(meta?.sessionId).toBeTruthy();

    // Drain first, then dispatch — consume is long-poll shaped, and this
    // is the ordering a live mount actually produces (the surface is up
    // and waiting before the user clicks).
    const consumePromise = host.callTool('ggui_consume', {
      sessionId: meta!.sessionId,
    });
    await host.simulateSubmitAction({
      meta: meta!,
      intent: 'save the draft',
      data: { draft: 'hello' },
    });

    const consumed = await consumePromise;
    expect(
      consumed.isError ?? false,
      `ggui_consume rejected a session that accepted the gesture: ${JSON.stringify(consumed)}`,
    ).toBe(false);
  });
});
