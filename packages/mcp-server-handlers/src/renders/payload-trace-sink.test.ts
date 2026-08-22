/**
 * Payload-trace sink travels the CALL PATH, never module-global state
 * (ggui#605 — #604's structural rule): the registrar (`@ggui-ai/
 * mcp-server` wires the console's bounded ring) and the emitters
 * (render/update handlers in THIS package) sit on opposite sides of a
 * package boundary; a module-global registry across that boundary goes
 * dark under any loader topology that splits module instances (the
 * #591/#604 failure mode — OTEL-style ESM instrumentation, dual-
 * resolution bundling). The sink is now a handler DEP; these tests pin
 * the seam.
 */
import { describe, expect, it } from 'vitest';
import {
  emitPayloadTraceEvent,
  type PayloadTraceEvent,
  type PayloadTraceSink,
} from './payload-trace-sink.js';

function recordingSink(): { sink: PayloadTraceSink; events: PayloadTraceEvent[] } {
  const events: PayloadTraceEvent[] = [];
  return {
    sink: {
      emit(event) {
        events.push(event);
      },
    },
    events,
  };
}

const INPUT = {
  direction: 'inbound-render',
  sessionId: 'render_1',
  appId: 'app_1',
  tool: 'ggui_render',
  payload: { intent: 'a card' },
} as const;

describe('emitPayloadTraceEvent — call-path sink (ggui#605)', () => {
  it('dispatches to exactly the sink it was HANDED — two sinks never cross', () => {
    const a = recordingSink();
    const b = recordingSink();
    emitPayloadTraceEvent(a.sink, INPUT);
    emitPayloadTraceEvent(b.sink, { ...INPUT, sessionId: 'render_2' });
    expect(a.events.map((e) => e.sessionId)).toEqual(['render_1']);
    expect(b.events.map((e) => e.sessionId)).toEqual(['render_2']);
  });

  it('stamps id/at/byteSize on the way through', () => {
    const a = recordingSink();
    emitPayloadTraceEvent(a.sink, INPUT);
    const event = a.events[0];
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.at).toBeGreaterThan(0);
    expect(event.byteSize).toBeGreaterThan(0);
  });

  it('null/undefined sink = zero-cost no-op (the unwired-handler hot path)', () => {
    expect(() => emitPayloadTraceEvent(null, INPUT)).not.toThrow();
    expect(() => emitPayloadTraceEvent(undefined, INPUT)).not.toThrow();
  });

  it('a throwing sink never breaks tool dispatch', () => {
    const broken: PayloadTraceSink = {
      emit() {
        throw new Error('devtools sink exploded');
      },
    };
    expect(() => emitPayloadTraceEvent(broken, INPUT)).not.toThrow();
  });

  it('the module exports NO global registry — the #605 topology is structurally gone', async () => {
    const mod: Record<string, unknown> = await import('./payload-trace-sink.js');
    expect(mod.setPayloadTraceSink).toBeUndefined();
    expect(mod.getPayloadTraceSink).toBeUndefined();
  });
});
