/**
 * handleStream — validation branches + derivation correctness.
 *
 * These tests exercise every rule on the design lock. Transport / buffer
 * behavior is injected via a spy `sendEnvelope` — the helper must never
 * call it before validation has passed.
 */
import { describe, it, expect, vi } from 'vitest';
import { ContractViolationError, type StackItem, type StreamSpec } from '@ggui-ai/protocol';
import {
  handleStream,
  ChannelNotDeclaredError,
  InvalidCompleteError,
  NoActiveStackItemError,
  StackItemNotFoundError,
  type HandleStreamEnvelope,
  type SendEnvelopeFn,
  type StreamSessionTarget,
} from './index.js';

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

function mkSession(overrides: Partial<StreamSessionTarget> = {}): StreamSessionTarget {
  const item: Partial<StackItem> & { id: string; streamSpec?: StreamSpec } = {
    id: 'card_1',
    streamSpec: BASIC_SPEC,
  };
  return {
    sessionId: 'sess_1',
    stack: [item],
    currentStackIndex: 0,
    ...overrides,
  };
}

function okSend(seq?: number): SendEnvelopeFn {
  return vi.fn(async () => (seq !== undefined ? { seq } : {}));
}

describe('handleStream', () => {
  describe('validation — stack resolution', () => {
    it('throws NoActiveStackItemError when stack is empty and no stackItemId supplied', async () => {
      const send = okSend();
      await expect(
        handleStream(
          { sessionId: 'sess_1', channel: 'message', payload: { text: 'hi' } },
          { session: mkSession({ stack: [] }), sendEnvelope: send },
        ),
      ).rejects.toBeInstanceOf(NoActiveStackItemError);
      expect(send).not.toHaveBeenCalled();
    });

    it('throws StackItemNotFoundError when stackItemId supplied but absent', async () => {
      const send = okSend();
      await expect(
        handleStream(
          { sessionId: 'sess_1', channel: 'message', payload: { text: 'hi' }, stackItemId: 'nope' },
          { session: mkSession(), sendEnvelope: send },
        ),
      ).rejects.toBeInstanceOf(StackItemNotFoundError);
      expect(send).not.toHaveBeenCalled();
    });

    it('resolves by stackItemId when supplied', async () => {
      const itemA: Partial<StackItem> & { id: string; streamSpec?: StreamSpec } = {
        id: 'card_a',
        streamSpec: { alpha: { schema: { type: 'string' } } },
      };
      const itemB: Partial<StackItem> & { id: string; streamSpec?: StreamSpec } = {
        id: 'card_b',
        streamSpec: BASIC_SPEC,
      };
      const session: StreamSessionTarget = {
        sessionId: 'sess_1',
        stack: [itemA, itemB],
        currentStackIndex: 1,
      };
      const send = okSend();

      await handleStream(
        { sessionId: 'sess_1', channel: 'alpha', payload: 'ok', stackItemId: 'card_a' },
        { session, sendEnvelope: send },
      );

      expect(send).toHaveBeenCalledTimes(1);
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call.channel).toBe('alpha');
    });

    it('falls back to currentStackIndex when no stackItemId supplied', async () => {
      const send = okSend();
      await handleStream(
        { sessionId: 'sess_1', channel: 'message', payload: { text: 'hi' } },
        { session: mkSession(), sendEnvelope: send },
      );
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('clamps out-of-range currentStackIndex to the top of the stack', async () => {
      const send = okSend();
      await handleStream(
        { sessionId: 'sess_1', channel: 'message', payload: { text: 'hi' } },
        { session: mkSession({ currentStackIndex: 99 }), sendEnvelope: send },
      );
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation — streamSpec + channel declared', () => {
    it('throws ChannelNotDeclaredError when resolved item has no streamSpec', async () => {
      const itemNoSpec: Partial<StackItem> & { id: string; streamSpec?: StreamSpec } = { id: 'card_1' };
      const session: StreamSessionTarget = {
        sessionId: 'sess_1',
        stack: [itemNoSpec],
        currentStackIndex: 0,
      };
      const send = okSend();
      await expect(
        handleStream(
          { sessionId: 'sess_1', channel: 'message', payload: { text: 'hi' } },
          { session, sendEnvelope: send },
        ),
      ).rejects.toBeInstanceOf(ChannelNotDeclaredError);
      expect(send).not.toHaveBeenCalled();
    });

    it('throws ChannelNotDeclaredError when channel missing from spec', async () => {
      const send = okSend();
      await expect(
        handleStream(
          { sessionId: 'sess_1', channel: 'unknown-channel', payload: {} },
          { session: mkSession(), sendEnvelope: send },
        ),
      ).rejects.toBeInstanceOf(ChannelNotDeclaredError);
      expect(send).not.toHaveBeenCalled();
    });

    it('error carries the declared channel list for debugging', async () => {
      try {
        await handleStream(
          { sessionId: 'sess_1', channel: 'nope', payload: {} },
          { session: mkSession(), sendEnvelope: okSend() },
        );
        throw new Error('should have thrown');
      } catch (e) {
        if (e instanceof ChannelNotDeclaredError) {
          expect(e.declaredChannels).toEqual(['message', 'status', 'log']);
          expect(e.channel).toBe('nope');
          expect(e.stackItemId).toBe('card_1');
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
          { sessionId: 'sess_1', channel: 'message', payload: { wrong: 'shape' } },
          { session: mkSession(), sendEnvelope: send },
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
          { sessionId: 'sess_1', channel: 'message', payload: { text: 'hi' }, complete: true },
          { session: mkSession(), sendEnvelope: send },
        ),
      ).rejects.toBeInstanceOf(InvalidCompleteError);
      expect(send).not.toHaveBeenCalled();
    });

    it('allows complete=true on a channel declared completable', async () => {
      const send = okSend();
      await handleStream(
        { sessionId: 'sess_1', channel: 'log', payload: { line: 'done' }, complete: true },
        { session: mkSession(), sendEnvelope: send },
      );
      expect(send).toHaveBeenCalledTimes(1);
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call.complete).toBe(true);
    });

    it('omits complete from envelope when input.complete is false/undefined', async () => {
      const send = okSend();
      await handleStream(
        { sessionId: 'sess_1', channel: 'message', payload: { text: 'hi' } },
        { session: mkSession(), sendEnvelope: send },
      );
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect('complete' in call).toBe(false);
    });
  });

  describe('mode derivation', () => {
    it('derives append mode from spec', async () => {
      const send = okSend();
      await handleStream(
        { sessionId: 'sess_1', channel: 'message', payload: { text: 'hi' } },
        { session: mkSession(), sendEnvelope: send },
      );
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call.mode).toBe('append');
    });

    it('derives replace mode from spec', async () => {
      const send = okSend();
      await handleStream(
        { sessionId: 'sess_1', channel: 'status', payload: { active: true } },
        { session: mkSession(), sendEnvelope: send },
      );
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call.mode).toBe('replace');
    });

    it('defaults to append when spec omits mode', async () => {
      const send = okSend();
      // channel 'log' has no `mode` on the spec — resolveStreamChannel applies default.
      await handleStream(
        { sessionId: 'sess_1', channel: 'log', payload: { line: 'x' } },
        { session: mkSession(), sendEnvelope: send },
      );
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call.mode).toBe('append');
    });
  });

  describe('output', () => {
    it('returns { accepted: true } when sendEnvelope returns no seq', async () => {
      const send = okSend();
      const out = await handleStream(
        { sessionId: 'sess_1', channel: 'message', payload: { text: 'hi' } },
        { session: mkSession(), sendEnvelope: send },
      );
      expect(out).toEqual({ accepted: true });
    });

    it('propagates seq when sendEnvelope returns one', async () => {
      const send = okSend(42);
      const out = await handleStream(
        { sessionId: 'sess_1', channel: 'message', payload: { text: 'hi' } },
        { session: mkSession(), sendEnvelope: send },
      );
      expect(out).toEqual({ accepted: true, seq: 42 });
    });
  });

  describe('sendEnvelope shape', () => {
    it('builds envelope with sessionId/channel/mode/payload (and complete when set)', async () => {
      const send = okSend(7);
      await handleStream(
        { sessionId: 'sess_1', channel: 'log', payload: { line: 'end' }, complete: true },
        { session: mkSession(), sendEnvelope: send },
      );
      const call = (send as unknown as { mock: { calls: [HandleStreamEnvelope][] } }).mock.calls[0][0];
      expect(call).toEqual({
        sessionId: 'sess_1',
        channel: 'log',
        mode: 'append',
        payload: { line: 'end' },
        complete: true,
      });
    });
  });
});
