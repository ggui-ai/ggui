/**
 * Live-channel unit tests — server-side derivation of the agent-facing
 * `tool` hint on consume events.
 *
 * The persisted `user.submitted` envelope IS the consume event the
 * agent drains, and `handleInboundAction`'s appendEvent call is the
 * single authoritative build site for `ActionEventValue.tool`:
 *
 *   - inbound `data:submit` with NO client `tool` + an
 *     `actionSpec[action].nextStep` declaration → the persisted
 *     payload carries the derived hint;
 *   - inbound action with neither client `tool` nor `nextStep` → the
 *     persisted payload carries NO `tool` field;
 *   - a client-populated `tool` is preserved verbatim (the derivation
 *     only fills the gap).
 *
 * Lane 3 (in-process): real WS round-trip against a bare node http
 * server + `createGguiSessionChannelServer`, asserting on the
 * `InMemoryGguiSessionStore` event ledger after the action ack.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type {
  ActionEnvelope,
  ActionEventValue,
  ActionSpec,
} from '@ggui-ai/protocol';
import {
  InMemoryAuthAdapter,
  InMemoryGguiSessionStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiSessionChannelServer } from './ggui-session-channel.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const APP_ID = 'app-channel-test';

interface Fixture {
  readonly httpServer: HttpServer;
  readonly store: InMemoryGguiSessionStore;
  readonly sessionId: string;
  readonly ws: WebSocket;
  /** Resolves with the next frame whose `type` matches. */
  readonly nextFrame: (type: string) => Promise<Record<string, unknown>>;
  readonly close: () => Promise<void>;
}

/**
 * Boot a channel server over a bare http server, commit a component
 * render carrying the given actionSpec, subscribe a real WS client,
 * and hand back frame-pump helpers. Subscribe ack is already consumed
 * when this resolves.
 */
async function bootSubscribed(actionSpec: ActionSpec): Promise<Fixture> {
  const store = new InMemoryGguiSessionStore();
  const sessionId = randomUUID();
  const now = Date.now();
  await store.commit({
    appId: APP_ID,
    render: {
      id: sessionId,
      appId: APP_ID,
      type: 'component',
      componentCode: 'export default function C() { return null; }',
      eventSequence: 0,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
      actionSpec,
    },
  });

  const channel = createGguiSessionChannelServer({
    renderStore: store,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    logger: silentLogger,
  });

  const httpServer = createServer();
  httpServer.on('upgrade', (req, socket, head) => {
    channel.handleUpgrade(req, socket, head);
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('httpServer.address() did not return AddressInfo');
  }

  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}${channel.path}`, {
    headers: { authorization: 'Bearer channel-test-token' },
  });
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (raw) => {
    frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
    for (const wake of waiters.splice(0)) wake();
  });
  const nextFrame = async (type: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const idx = frames.findIndex((f) => f['type'] === type);
      if (idx >= 0) return frames.splice(idx, 1)[0]!;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for '${type}' frame`);
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      payload: { sessionId, appId: APP_ID },
      requestId: randomUUID(),
    }),
  );
  await nextFrame('ack');

  return {
    httpServer,
    store,
    sessionId,
    ws,
    nextFrame,
    close: async () => {
      ws.close();
      await channel.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

/** Send a `data:submit` action frame and await its ack. */
async function submitAction(
  fx: Fixture,
  payload: ActionEventValue,
): Promise<void> {
  fx.ws.send(
    JSON.stringify({
      type: 'action',
      payload: {
        sessionId: fx.sessionId,
        type: 'data:submit',
        payload,
      },
      requestId: randomUUID(),
    }),
  );
  const ack = await fx.nextFrame('ack');
  expect((ack['payload'] as { sequence: number }).sequence).toBeGreaterThan(0);
}

/** Read the single persisted consume event's ActionEventValue payload. */
async function persistedPayload(fx: Fixture): Promise<ActionEventValue> {
  const page = await fx.store.listEventsSince(fx.sessionId, 0, 10);
  expect(page).not.toBeNull();
  expect(page!.events).toHaveLength(1);
  expect(page!.events[0]!.type).toBe('user.submitted');
  const envelope = page!.events[0]!.data as ActionEnvelope<ActionEventValue>;
  expect(envelope.type).toBe('data:submit');
  return envelope.payload as ActionEventValue;
}

describe('handleInboundAction — server-side tool-hint derivation (consume-event build site)', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  it('stamps actionSpec[action].nextStep onto the persisted event when the client sends no tool', async () => {
    fx = await bootSubscribed({
      archive: {
        label: 'Archive',
        nextStep: 'todo_archive',
        schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    });
    await submitAction(fx, { action: 'archive', data: { id: 't1' } });
    const payload = await persistedPayload(fx);
    expect(payload.tool).toBe('todo_archive');
    // The derivation builds a fresh payload — the rest passes through.
    expect(payload.action).toBe('archive');
    expect(payload.data).toEqual({ id: 't1' });
  });

  it('persists no tool field when the action declares no nextStep and the client sends none', async () => {
    fx = await bootSubscribed({
      ping: { label: 'Ping' },
    });
    await submitAction(fx, { action: 'ping', data: null });
    const payload = await persistedPayload(fx);
    expect('tool' in payload).toBe(false);
  });

  it('preserves a client-populated tool verbatim (derivation only fills the gap)', async () => {
    fx = await bootSubscribed({
      archive: {
        label: 'Archive',
        nextStep: 'todo_archive',
        schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    });
    await submitAction(fx, {
      action: 'archive',
      data: { id: 't2' },
      tool: 'client_supplied_tool',
    });
    const payload = await persistedPayload(fx);
    expect(payload.tool).toBe('client_supplied_tool');
  });
});
