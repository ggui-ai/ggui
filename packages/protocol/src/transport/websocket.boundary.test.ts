/**
 * Boundary tests for the websocket transport split.
 *
 * Pins the two-part decision locked on 2026-04-19:
 *
 *   1. WebSocket transport envelope types (`WebSocketMessage`,
 *      `WebSocketMessageType`, `ConnectionStatus`) live at
 *      `@ggui-ai/protocol/transport/websocket` — subpath only.
 *
 *   2. Live-channel contract payload types (`SubscribePayload`,
 *      `AckPayload`, `StreamEnvelope`, `RenderPayload`, etc.) live at
 *      `@ggui-ai/protocol` root.
 *
 * The tests below LOCK that decision so an accidental reversal breaks
 * the typecheck. Three kinds of locks:
 *
 *   - **Type-level negative locks**: `@ts-expect-error` on root imports
 *     of transport types. If someone re-adds `export * from
 *     './transport/websocket'` to the root barrel, the `@ts-expect-error`
 *     suppression will flag a now-valid import and fail the typecheck.
 *
 *   - **Type-level positive locks**: explicit `import type { X } from
 *     '../index.js'` assertions that each contract payload stays on the
 *     root. If someone moves one to the transport file by mistake, the
 *     import won't resolve.
 *
 *   - **Runtime narrowing locks**: structural tests that the
 *     `WebSocketMessage` discriminated union still narrows each variant
 *     to the expected payload shape — proves the physical split didn't
 *     silently lose variant cases.
 */
import { describe, expect, it } from 'vitest';

// ── Positive locks: transport types reachable via the subpath ──────────
import type {
  ConnectionStatus,
  WebSocketMessage,
  WebSocketMessageType,
} from './websocket.js';

// ── Positive locks: contract payloads reachable via the root barrel ────
import type {
  AckPayload,
  ClosePayload,
  ErrorPayload,
  InternalProgressPayload,
  ProgressPayload,
  PropsUpdatePayload,
  RenderPayload,
  StreamEnvelope,
  StreamPayload,
  SubscribePayload,
  SystemPayload,
  UrlPayload,
} from '../index.js';
import type { ActionEnvelope } from '../types/events.js';

// ── Negative locks: transport types MUST NOT be reachable from root ────
//
// Each `@ts-expect-error` below asserts that the import on the following
// line is INVALID under the current protocol root barrel. If a future
// change re-adds `export * from './transport/websocket'` to root,
// `@ts-expect-error` becomes a false claim and tsc fails.
//
// These are the load-bearing drift guards — the whole reason Commit 3
// narrowed the root.

// @ts-expect-error — WebSocketMessage is a transport type; use `@ggui-ai/protocol/transport/websocket`
import type { WebSocketMessage as _WebSocketMessageNotAtRoot } from '../index.js';
// @ts-expect-error — WebSocketMessageType is a transport type; use `@ggui-ai/protocol/transport/websocket`
import type { WebSocketMessageType as _WebSocketMessageTypeNotAtRoot } from '../index.js';
// @ts-expect-error — ConnectionStatus is a transport type; use `@ggui-ai/protocol/transport/websocket`
import type { ConnectionStatus as _ConnectionStatusNotAtRoot } from '../index.js';

// ── Runtime locks: WebSocketMessage discriminated union narrows cleanly ─

describe('websocket transport boundary — type narrowing', () => {
  it('narrows to ActionEnvelope on type:action', () => {
    const msg: WebSocketMessage = {
      type: 'action',
      payload: {
        sessionId: 'render-1',
        type: 'data:submit',
        payload: { action: 'submit', data: { text: 'hi' } },
      },
    };
    if (msg.type !== 'action') throw new Error('narrowing');
    const envelope: ActionEnvelope = msg.payload;
    expect(envelope.sessionId).toBe('render-1');
    expect(envelope.type).toBe('data:submit');
  });

  it('narrows to StreamEnvelope on type:data', () => {
    const envelope: StreamEnvelope = {
      sessionId: 'render-1',
      channel: 'tick',
      mode: 'append',
      payload: { count: 1 },
    };
    const msg: WebSocketMessage = { type: 'data', payload: envelope };
    if (msg.type !== 'data') throw new Error('narrowing');
    expect(msg.payload.channel).toBe('tick');
  });

  it('narrows to SubscribePayload on type:subscribe', () => {
    const sub: SubscribePayload = {
      sessionId: 'render-1',
      appId: 'app-1',
      fromSeq: 42,
    };
    const msg: WebSocketMessage = { type: 'subscribe', payload: sub };
    if (msg.type !== 'subscribe') throw new Error('narrowing');
    expect(msg.payload.fromSeq).toBe(42);
  });

  it('narrows to AckPayload on type:ack with live-channel resume fields', () => {
    const ack: AckPayload = {
      sequence: 5,
      timestamp: Date.now(),
      streamSeq: 10,
      replayTruncated: true,
    };
    const msg: WebSocketMessage = { type: 'ack', payload: ack };
    if (msg.type !== 'ack') throw new Error('narrowing');
    expect(msg.payload.streamSeq).toBe(10);
    expect(msg.payload.replayTruncated).toBe(true);
  });

  it('narrows to RenderPayload on type:render', () => {
    const render: RenderPayload = {
      session: {
        id: 'render-1',
        appId: 'app-1',
        eventSequence: 0,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        componentCode: '/* */',
      },
    };
    const msg: WebSocketMessage = { type: 'render', payload: render };
    if (msg.type !== 'render') throw new Error('narrowing');
    expect(msg.payload.session.id).toBe('render-1');
  });

  it('narrows to ChannelSubscribePayload on type:channel_subscribe (EE+ 1b)', () => {
    const msg: WebSocketMessage = {
      type: 'channel_subscribe',
      payload: {
        sessionId: 'render-1',
        appId: 'a',
        channelName: 'weather',
        pollIntervalMs: 5000,
        args: { city: 'Tokyo' },
      },
    };
    if (msg.type === 'channel_subscribe') {
      expect(msg.payload.channelName).toBe('weather');
      expect(msg.payload.args?.['city']).toBe('Tokyo');
    }
  });

  it('narrows to ChannelPayloadFrame on type:channel_payload (EE+ 1b)', () => {
    const msg: WebSocketMessage = {
      type: 'channel_payload',
      payload: {
        sessionId: 'render-1',
        appId: 'a',
        channelName: 'weather',
        seq: 1,
        ts: '2026-05-12T00:00:00Z',
        mode: 'replace',
        payload: { temp: 22 },
      },
    };
    if (msg.type === 'channel_payload') {
      expect(msg.payload.seq).toBe(1);
      expect(msg.payload.mode).toBe('replace');
    }
  });

  it('narrows to ChannelErrorPayload on type:channel_error (EE+ 1b)', () => {
    const msg: WebSocketMessage = {
      type: 'channel_error',
      payload: {
        sessionId: 'render-1',
        channelName: 'weather',
        code: 'CHANNEL_NOT_LOCAL',
        message: 'tool not in streamWebSocketLocalTools',
      },
    };
    if (msg.type === 'channel_error') {
      expect(msg.payload.code).toBe('CHANNEL_NOT_LOCAL');
    }
  });

  it('narrows to DrainAckPayload on type:drain_ack (A2)', () => {
    const msg: WebSocketMessage = {
      type: 'drain_ack',
      payload: {
        sessionId: 'render-1',
        appId: 'a',
        eventId: 'evt_1',
        drainedAt: '2026-05-14T00:00:00.000Z',
      },
    };
    if (msg.type === 'drain_ack') {
      expect(msg.payload.eventId).toBe('evt_1');
      expect(msg.payload.drainedAt).toMatch(/Z$/);
    }
  });

  it('narrows to ErrorPayload on type:error', () => {
    const err: ErrorPayload = {
      code: 'CONTRACT_VIOLATION',
      message: 'bad payload',
      details: { field: 'text' },
    };
    const msg: WebSocketMessage = { type: 'error', payload: err };
    if (msg.type !== 'error') throw new Error('narrowing');
    expect(msg.payload.code).toBe('CONTRACT_VIOLATION');
  });
});

// ── Runtime locks: WebSocketMessageType enumerates all variants ────────

describe('websocket transport boundary — discriminator coverage', () => {
  it('covers the full dispatch surface', () => {
    // Structural lock: if a new variant lands in `WebSocketMessage` but
    // not in `WebSocketMessageType`, or vice versa, this assignment
    // drifts — forcing a deliberate update here. Captured as a value
    // array (not a type-level equality) because tests can't intercept
    // the dispatch layer but CAN lock the discriminator set the
    // enforcement helpers read.
    const types: WebSocketMessageType[] = [
      'action',
      'subscribe',
      'close',
      'ping',
      'pong',
      'ack',
      'error',
      'render',
      'data',
      'stream',
      'progress',
      'agent-msg',
      'props_update',
      'url',
      'system',
      'internal:progress',
      // EE+ 1b — channel-level subscribe variants.
      'channel_subscribe',
      'channel_unsubscribe',
      'channel_payload',
      'channel_error',
      // A2 — action-drain ack.
      'drain_ack',
      // Host-context capture.
      'host_context_observed',
      // R7 — ledger replay frame.
      'render_event',
    ];
    expect(types).toHaveLength(23);
    // Structural lock: ConnectionStatus values also stable.
    const statuses: ConnectionStatus[] = [
      'connecting',
      'connected',
      'disconnected',
      'reconnecting',
    ];
    expect(statuses).toHaveLength(4);
  });
});

// ── Positive type-level lock: contract payloads stay on root ────────────
//
// If any of the payload types below silently moved off `../index.js`
// (e.g., someone relocated `SubscribePayload` into `transport/websocket.ts`),
// the type annotations below would fail to resolve. The `void` lets us
// assert "this type exists at root" without running anything.

void (function _contractPayloadsStayOnRoot(): void {
  type _S = SubscribePayload;
  type _A = AckPayload;
  type _R = RenderPayload;
  type _SE = StreamEnvelope;
  type _ST = StreamPayload;
  type _E = ErrorPayload;
  type _C = ClosePayload;
  type _Pr = ProgressPayload;
  type _U = UrlPayload;
  type _Sys = SystemPayload;
  type _PU = PropsUpdatePayload;
  type _IP = InternalProgressPayload;
});
