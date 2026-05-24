/**
 * Scenario 24 — canvas-mode `ggui_push` routes to the existing canvas
 * iframe (NOT a fresh per-push iframe).
 *
 * Once the canvas iframe completes its handshake (live-channel subscribe
 * with the session-scoped resource), the server's `push.resultMeta`
 * MUST omit `_meta.ui.resourceUri` — otherwise the MCP host would
 * mount a second iframe per push, defeating the canvas model.
 *
 * Flow (no LLM):
 *
 *   1. Pre-register a blueprint via `ggui_ops_register_blueprint`
 *      so handshake + push hit the cache fast path (same trick as
 *      scenario 18).
 *   2. Call `ggui_new_session` on the canvas-demo server. Server
 *      resolves `defaultMcpAppsMode = 'canvas'` from the manifest and
 *      stamps `_meta.ui.resourceUri = ui://ggui/session/<id>` (the
 *      contract scenario 23 already pins).
 *   3. Open a Node WebSocket to `/ws`, send a `subscribe` message
 *      with `{ sessionId, appId: 'builder' }`. Dev-allow-all skips
 *      the bootstrap-token path; the server's `handleSubscribe`
 *      still observes `session.mcpAppsMode === 'canvas'` and flips
 *      `session.canvasLoaded = true` on the first subscribe-ack.
 *   4. Call `ggui_handshake` (cache origin) and `ggui_push`
 *      (cache hit; no cold-gen).
 *   5. Assert: push response's `_meta` is absent OR does NOT carry
 *      `ui.resourceUri` (canvasOwnsRender path took over).
 *
 * Compare with scenario 18 (non-canvas), whose push response stamps
 * `_meta.ui.resourceUri` + `ggui.bootstrap` so the MCP host can mount
 * a per-push iframe. The difference between the two scenarios IS the
 * canvas-mode contract.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';

const CANVAS_PORT = Number.parseInt(process.env.GGUI_CANVAS_PORT ?? '6786', 10);
const MCP_URL = `http://localhost:${CANVAS_PORT}/mcp`;
const OPS_URL = `http://localhost:${CANVAS_PORT}/ops`;
const WS_URL = `ws://localhost:${CANVAS_PORT}/ws`;

// Unique signature — keeps this scenario's blueprint slot clean of
// cross-test pollution from 18/8/17 (each scenario carries its own
// per-test contract by design — see scenario 18's note).
const CANVAS_TEST_CONTRACT = {
  propsSpec: {
    description: 'scenario 24 — canvas-mode push routing test',
    properties: {
      label: {
        schema: { type: 'string' },
        required: false,
        description: 'optional label',
      },
    },
  },
} as const;

const CANVAS_TEST_COMPONENT_CODE =
  "export default function CanvasModeRouteTest() { return null; }\n";

const SUBSCRIBE_REQUEST_ID = 'scenario-24-subscribe';

/**
 * Open a Node WebSocket, send a single `subscribe` message, and
 * resolve once the server emits the matching `ack` envelope. Rejects
 * on any `error` envelope or socket failure. Closes the socket on
 * completion (we don't need to keep the subscription open — the
 * `canvasLoaded` flip is durable on the session).
 */
async function subscribeAndAwaitAck(
  sessionId: string,
  appId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // best-effort
      }
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`subscribe ack timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          payload: { sessionId, appId },
          requestId: SUBSCRIBE_REQUEST_ID,
        }),
      );
    });
    ws.addEventListener('message', (event) => {
      let parsed: unknown;
      try {
        const raw =
          typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const msg = parsed as { type?: string; requestId?: string };
      // AckPayload doesn't carry sessionId; the requestId echo is the
      // canonical match. Either an `ack` for our subscribe (success)
      // or an `error` envelope (subscribe rejection) settles the wait.
      if (msg?.type === 'ack' && msg.requestId === SUBSCRIBE_REQUEST_ID) {
        clearTimeout(timer);
        finish();
      } else if (msg?.type === 'error') {
        clearTimeout(timer);
        finish(new Error(`subscribe error envelope: ${JSON.stringify(parsed)}`));
      }
    });
    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      finish(new Error(`WebSocket error: ${String(event)}`));
    });
  });
}

interface NewSessionResult {
  readonly sessionId: string;
}

interface OpsRegisterOut {
  readonly blueprintId: string;
  readonly codeHash: string;
}

interface HandshakeOut {
  readonly handshakeId: string;
  readonly suggestion: {
    readonly origin: 'cache' | 'agent' | 'synth';
  };
}

interface PushOut {
  readonly stackItemId: string;
}

describe('Scenario 24 — canvas-mode push omits per-push ui.resourceUri', () => {
  test(
    'after canvas subscribe, ggui_push response carries no _meta.ui.resourceUri',
    async () => {
      const expectedCodeHash = createHash('sha256')
        .update(CANVAS_TEST_COMPONENT_CODE)
        .digest('hex');

      const ops = unwrapStructured<OpsRegisterOut>(
        await callTool(OPS_URL, 'ggui_ops_register_blueprint', {
          contract: CANVAS_TEST_CONTRACT,
          componentCode: CANVAS_TEST_COMPONENT_CODE,
        }),
      );
      expect(ops.codeHash).toBe(expectedCodeHash);

      const newSessionResp = await callTool(MCP_URL, 'ggui_new_session', {});
      const sc = unwrapStructured<NewSessionResult>(newSessionResp);
      const sessionResourceUri = (
        newSessionResp.result?._meta as { ui?: { resourceUri?: string } } | undefined
      )?.ui?.resourceUri;
      // The canvas-mode resourceUri stamp proves the session is in
      // canvas mode — the agent-facing structuredContent doesn't echo
      // the mode (stripped by output schema; see scenario 23 for the
      // rationale).
      expect(sessionResourceUri).toBe(`ui://ggui/session/${sc.sessionId}`);

      // Subscribe to the session channel. Dev-allow-all means the
      // upgrade-time bearer check is bypassed; the subscribe payload
      // doesn't carry a bootstrap token. The canvasLoaded flip
      // happens on the first session-wide ack regardless of which
      // auth path landed the identity.
      await subscribeAndAwaitAck(sc.sessionId, 'builder', 10_000);

      const handshake = unwrapStructured<HandshakeOut>(
        await callTool(MCP_URL, 'ggui_handshake', {
          sessionId: sc.sessionId,
          intent: 'paraphrased intent for canvas-mode push routing',
          blueprintDraft: { contract: CANVAS_TEST_CONTRACT },
        }),
      );
      expect(handshake.suggestion.origin).toBe('cache');

      const pushResp = await callTool(MCP_URL, 'ggui_push', {
        handshakeId: handshake.handshakeId,
        decision: { kind: 'accept' },
      });
      const push = unwrapStructured<PushOut>(pushResp);
      expect(typeof push.stackItemId).toBe('string');

      // The canvas-mode contract: _meta is absent OR lacks
      // ui.resourceUri. push.ts's canvasOwnsRender branch returns
      // `undefined` from resultMeta when both flags are set.
      const pushMeta = pushResp.result?._meta as
        | { ui?: { resourceUri?: string } }
        | undefined;
      expect(pushMeta?.ui?.resourceUri).toBeUndefined();
    },
    30_000,
  );
});
