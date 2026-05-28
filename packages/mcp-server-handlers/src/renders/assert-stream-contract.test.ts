import { describe, it, expect } from 'vitest';
import { ContractViolationError, type StreamSpec } from '@ggui-ai/protocol';
import { assertStreamContract } from './assert-stream-contract.js';

const SPEC: StreamSpec = {
  tick: {
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
      },
      required: ['count'],
    },
  },
};

describe('assertStreamContract', () => {
  it('is a no-op when spec is undefined (missing streamSpec = permissive)', () => {
    expect(() => assertStreamContract(undefined, 'whatever', {})).not.toThrow();
  });

  it('passes when channel is declared and payload matches', () => {
    expect(() => assertStreamContract(SPEC, 'tick', { count: 3 })).not.toThrow();
  });

  it('rejects undeclared channel with tool=ggui_emit', () => {
    let err: unknown;
    try {
      assertStreamContract(SPEC, 'unknown-channel', {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContractViolationError);
    expect((err as ContractViolationError).tool).toBe('ggui_emit');
  });

  it('surfaces ContractViolationError with declared-channels list', () => {
    try {
      assertStreamContract(SPEC, 'mystery', {});
      throw new Error('should have thrown');
    } catch (e) {
      if (e instanceof ContractViolationError) {
        expect(e.violations[0].message).toContain('tick');
      } else {
        throw e;
      }
    }
  });

  describe('reserved-channel handling (F10 closed-set + Item 4 injection)', () => {
    // The server-owned `_ggui:*` namespace is authoritative: the
    // declaration side rejects agents who try to claim it, and the
    // client-side consumer re-runs the injected validators on receipt.
    // This handler-side throw-wrapper must match — otherwise a
    // provisional preview emit into a session whose active stack item
    // has ANY declared streamSpec would raise ContractViolationError
    // and abort the preview runner on its very first frame.
    it('does not throw on `_ggui:preview` when no validator is injected (fall-through)', () => {
      // Without `extraReservedValidators`, the reserved-channel path
      // falls through to `{valid: true}` for PREVIEW_CHANNEL (the
      // protocol ships no built-in — A2UI is injected at
      // composition time by the server).
      expect(() =>
        assertStreamContract(SPEC, '_ggui:preview', {
          version: 'v0.9',
          createSurface: { surfaceId: 's', catalogId: 'ggui.preview.v1' },
        }),
      ).not.toThrow();
    });

    it('does not throw on the terminal channel-close envelope (payload null) — no validator injected', () => {
      // The runner's `finalizePreviewChannel` emits `{payload: null,
      // complete: true}` on every exit path. Without an injected
      // `_ggui:preview` validator, null payloads pass the fall-through.
      expect(() =>
        assertStreamContract(SPEC, '_ggui:preview', null),
      ).not.toThrow();
    });

    it('rejects reserved-prefix typos via the F10 closed-set rule', () => {
      // `_ggui:future-channel` is NOT in KNOWN_RESERVED_CHANNELS; it
      // falls through to the declared-channel check which surfaces
      // the typo as an "Unknown stream channel" violation. This is
      // the F10 closed-set guarantee — typos inside the reserved
      // namespace surface at their emission point rather than
      // silently passing.
      let err: unknown;
      try {
        assertStreamContract(SPEC, '_ggui:future-channel', { x: 1 });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ContractViolationError);
      expect((err as ContractViolationError).violations[0].field).toBe(
        'channel',
      );
    });

    it('runs the protocol BUILTIN validator for `_ggui:contract-error` even without spec or injection', () => {
      // Protocol-owned validator for ContractErrorPayload fires from
      // BUILTIN_RESERVED_VALIDATORS regardless of caller-provided
      // extras. Reserved-channel branch inside `validateStreamData`
      // runs before the declared-channel check, so a session with
      // NO user streamSpec still rejects malformed contract-error
      // emissions.
      let err: unknown;
      try {
        assertStreamContract(
          undefined,
          '_ggui:contract-error',
          // missing toolName + error + timestamp
          { actionName: 'submit' },
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ContractViolationError);
      const cve = err as ContractViolationError;
      expect(cve.tool).toBe('ggui_emit');
      expect(cve.violations.map((v) => v.field)).toEqual(
        expect.arrayContaining(['toolName', 'error', 'timestamp']),
      );
    });

    it('accepts a well-formed `_ggui:contract-error` payload via BUILTIN', () => {
      expect(() =>
        assertStreamContract(SPEC, '_ggui:contract-error', {
          toolName: 'my-tool',
          error: { code: 'TOOL_THREW', message: 'boom' },
          timestamp: '2026-04-23T00:00:00.000Z',
        }),
      ).not.toThrow();
    });

    it('consults injected validators FIRST on known reserved channels', () => {
      // Injection overrides the BUILTIN — a caller that wants
      // stricter A2UI preview validation layers its own validator on
      // top.
      const strict = new Map([
        [
          '_ggui:preview',
          (_: unknown) => ({
            valid: false as const,
            violations: [
              {
                field: 'injected',
                message: 'injected rejection',
                expected: 'ok',
                received: 'nope',
              },
            ],
          }),
        ],
      ]);
      let err: unknown;
      try {
        assertStreamContract(
          SPEC,
          '_ggui:preview',
          { version: 'v0.9', deleteSurface: { surfaceId: 's' } },
          strict,
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ContractViolationError);
      expect((err as ContractViolationError).violations[0].field).toBe(
        'injected',
      );
    });
  });
});
