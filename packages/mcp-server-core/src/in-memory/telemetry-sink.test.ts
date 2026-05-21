/**
 * Reference-adapter tests for `NoopTelemetrySink` and
 * `InMemoryTelemetrySink`. The interface contract itself is
 * self-describing (see `telemetry-sink.ts`); these tests pin the
 * two OSS reference behaviours — silent drop vs. bounded retain
 * with oldest-drop — so downstream consumers can rely on them
 * without re-reading implementation source.
 */
import { describe, expect, it } from 'vitest';
import type { TelemetryEvent } from '../telemetry-sink.js';
import {
  InMemoryTelemetrySink,
  NoopTelemetrySink,
} from './telemetry-sink.js';

function sampleEvent(name: string, at = 1): TelemetryEvent {
  return { name, at };
}

describe('NoopTelemetrySink', () => {
  it('emit is a no-op (no observable side effect)', () => {
    const sink = new NoopTelemetrySink();
    // Proves emit does not throw under any input.
    expect(() => sink.emit(sampleEvent('anything'))).not.toThrow();
    expect(() =>
      sink.emit({
        name: 'with.attrs',
        at: 99,
        attributes: { n: 1, s: 'ok', b: true },
      }),
    ).not.toThrow();
  });
});

describe('InMemoryTelemetrySink — retention + lossy contract', () => {
  it('snapshot returns a copy — external mutation does not leak back', () => {
    const sink = new InMemoryTelemetrySink();
    sink.emit(sampleEvent('a'));
    const copy = sink.snapshot();
    copy.push(sampleEvent('spoof'));
    expect(sink.length).toBe(1);
  });

  it('drain returns buffered events in order and empties the buffer', () => {
    const sink = new InMemoryTelemetrySink();
    sink.emit(sampleEvent('one', 1));
    sink.emit(sampleEvent('two', 2));
    sink.emit(sampleEvent('three', 3));
    const out = sink.drain();
    expect(out.map((e) => e.name)).toEqual(['one', 'two', 'three']);
    expect(sink.length).toBe(0);
    expect(sink.drain()).toEqual([]);
  });

  it('capacity caps the buffer and drops oldest first', () => {
    const sink = new InMemoryTelemetrySink({ capacity: 2 });
    sink.emit(sampleEvent('one', 1));
    sink.emit(sampleEvent('two', 2));
    sink.emit(sampleEvent('three', 3));
    sink.emit(sampleEvent('four', 4));
    expect(sink.length).toBe(2);
    expect(sink.snapshot().map((e) => e.name)).toEqual(['three', 'four']);
  });

  it('capacity: Infinity means no cap', () => {
    const sink = new InMemoryTelemetrySink({ capacity: Infinity });
    for (let i = 0; i < 5000; i++) sink.emit(sampleEvent(`e${i}`, i));
    expect(sink.length).toBe(5000);
  });

  it('rejects invalid capacity at construction', () => {
    expect(() => new InMemoryTelemetrySink({ capacity: 0 })).toThrow(
      /capacity/i,
    );
    expect(() => new InMemoryTelemetrySink({ capacity: -1 })).toThrow(
      /capacity/i,
    );
    expect(() => new InMemoryTelemetrySink({ capacity: NaN })).toThrow(
      /capacity/i,
    );
  });

  it('preserves attributes verbatim on read', () => {
    const sink = new InMemoryTelemetrySink();
    sink.emit({
      name: 'with.attrs',
      at: 7,
      attributes: { n: 42, s: 'ok', b: false },
    });
    const [ev] = sink.snapshot();
    expect(ev!.attributes).toEqual({ n: 42, s: 'ok', b: false });
  });
});
