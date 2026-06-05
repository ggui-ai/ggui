/**
 * handleStream — validation branches + derivation correctness.
 *
 * Post-Phase-B (flatten-render-identity): the helper now takes a
 * `GguiSessionStreamTarget` (single render — no vessel, no stack). The
 * `NoActiveStackItemError` + `StackItemNotFoundError` matrix collapsed
 * — those errors are only meaningful when the stream target wraps a
 * stack of entries; with one render per target, "stack item not
 * found" is structurally impossible (the caller has already resolved
 * the render via `renderStore.get`).
 *
 * These tests exercise every rule on the design lock. Transport / buffer
 * behavior is injected via a spy `sendEnvelope` — the helper must never
 * call it before validation has passed.
 */
import { describe, it, expect, vi } from 'vitest';
import { ContractViolationError, type StreamSpec } from '@ggui-ai/protocol';
import {
  handleStream,
  type HandleStreamEnvelope,
  type SendEnvelopeFn,
  type GguiSessionStreamTarget,
} from './handle-stream.js';
import { ChannelNotDeclaredError, InvalidCompleteError } from './errors.js';

const BASIC_SPEC: StreamSpec = {
  message: {
    mode: 'append',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  status: {
    mode: 'replace',
    schema: { type: 'object', properties: { active: { type: 'boolean' } }, required: ['active'] },
  },
  log: {
    // mode omitted → defaults to 'append' via resolveStreamChannel
    complete: true,
    schema: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] },
  },
};

function mkRender(overrides: Partial<GguiSessionStreamTarget> = {}): GguiSessionStreamTarget {
  return {
    renderId: 'render_1',
    streamSpec: BASIC_SPEC,
    ...overrides,
  };
}

function okSend(seq?: number): SendEnvelopeFn {
  return vi.fn(async () => (seq !== undefined ? { seq } : {}));
}

describe('handleStream', () => {
  describe('validation — streamSpec + channel declared', () => {
    it('throws ChannelNotDeclaredError when the render has no streamSpec', async () => {
      const send = okSend();
      await expect(
        handleStream(
          { renderId: 'render_1', channel: 'message', payload: { text: 'hi' } },
          { render: mkRender({ streamSpec: undefined }), sendEnvelope: send },
        ),
      ).rejects.toBeInstanceOf(ChannelNotDeclaredError);
      expect(send).not.toHaveBeenCalled();
    });

    it('throws ChannelNotDeclaredError when channel missing from spec', async () => {
      const send = okSend();
      await expect(
        handleStream(
          { renderId: 'render_1', channel: 'unknown-channel', payload: {} },
          { render: mkRender(), sendEnvelope: send },
        ),
      ).rejects.toBeInstanceOf(ChannelNotDeclaredError);
      expect(send).not.toHaveBeenCalled();
    });

    it('error carries the declared channel list for debugging', async () => {
      try {
        await handleStream(
          { renderId: 'render_1', channel: 'nope', payload: {} },
          { render: mkRender(), sendEnvelope: okSend() },
        );
        throw new Error('should have thrown');
      } catch (e) {
        if (e instanceof ChannelNotDeclaredError) {
          expect(e.declaredChannels).toEqual(['message', 'status', 'log']);
          expect(e.channel).toBe('nope');
          expect(e.renderId).toBe('render_1');
        } else {
          throw e;
        }
      }
    });
  });

  describe('validation — payload schema', () => {
    it('throws ContractViolationError when payload violates the declared schema', async () => {
      const send = okSend();
      await expect(
        handleStream(
          { renderId: 'render_1', channel: 'message', payload: { wrong: 'shape' } },
          { render: mkRender(), sendEnvelope: send },
        ),
      ).rejects.toBeInstanceOf(ContractViolationError);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('validation — complete legality', () => {
    it('throws InvalidCompleteError when complete=true on a non-completable channel', async () => {
      const send = okSend();
      await expect(
        handleStream(
          { renderId: 'render_1', channel: 'message', payload: { text: 'hi' }, complete: true },
          { render: mkRender(), sendEnvelope: send },
        ),
      ).rejects.toBeInstanceOf(InvalidCompleteError);
      expect(send).not.toHaveBeenCalled();
    });

    it('allows complete=true on a channel declared completable', async () => {
      const send = okSend();
      await handleStream(
        { renderId: 'render_1', channel: 'log', payload: { line: 'done' }, complete: true },
        { render: mkRender(), sendEnvelope: send },
      );
      expect(send).toHaveBeenCalledTimes(1);
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call.complete).toBe(true);
    });

    it('omits complete from envelope when input.complete is false/undefined', async () => {
      const send = okSend();
      await handleStream(
        { renderId: 'render_1', channel: 'message', payload: { text: 'hi' } },
        { render: mkRender(), sendEnvelope: send },
      );
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect('complete' in call).toBe(false);
    });
  });

  describe('mode derivation', () => {
    it('derives append mode from spec', async () => {
      const send = okSend();
      await handleStream(
        { renderId: 'render_1', channel: 'message', payload: { text: 'hi' } },
        { render: mkRender(), sendEnvelope: send },
      );
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call.mode).toBe('append');
    });

    it('derives replace mode from spec', async () => {
      const send = okSend();
      await handleStream(
        { renderId: 'render_1', channel: 'status', payload: { active: true } },
        { render: mkRender(), sendEnvelope: send },
      );
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call.mode).toBe('replace');
    });

    it('defaults to append when spec omits mode', async () => {
      const send = okSend();
      // channel 'log' has no `mode` on the spec — resolveStreamChannel applies default.
      await handleStream(
        { renderId: 'render_1', channel: 'log', payload: { line: 'x' } },
        { render: mkRender(), sendEnvelope: send },
      );
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call.mode).toBe('append');
    });
  });

  describe('output', () => {
    it('returns { accepted: true } when sendEnvelope returns no seq', async () => {
      const send = okSend();
      const out = await handleStream(
        { renderId: 'render_1', channel: 'message', payload: { text: 'hi' } },
        { render: mkRender(), sendEnvelope: send },
      );
      expect(out).toEqual({ accepted: true });
    });

    it('propagates seq when sendEnvelope returns one', async () => {
      const send = okSend(42);
      const out = await handleStream(
        { renderId: 'render_1', channel: 'message', payload: { text: 'hi' } },
        { render: mkRender(), sendEnvelope: send },
      );
      expect(out).toEqual({ accepted: true, seq: 42 });
    });
  });

  describe('sendEnvelope shape', () => {
    it('builds envelope with renderId/channel/mode/payload (and complete when set)', async () => {
      const send = okSend(7);
      await handleStream(
        { renderId: 'render_1', channel: 'log', payload: { line: 'end' }, complete: true },
        { render: mkRender(), sendEnvelope: send },
      );
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call).toEqual({
        renderId: 'render_1',
        channel: 'log',
        mode: 'append',
        payload: { line: 'end' },
        complete: true,
      });
    });
  });
});
