import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createStderrCacheTraceSink,
  createStdoutJsonCacheTraceSink,
  emitCacheTraceEvent,
  setCacheTraceSink,
  newCacheTraceId,
  type CacheTraceEvent,
} from './cache-trace-sink.js';

/**
 * Build a minimal valid {@link CacheTraceEvent}. The sink only projects
 * a subset of fields; tests override exactly the ones under assertion.
 */
function makeEvent(overrides: Partial<CacheTraceEvent> = {}): CacheTraceEvent {
  return {
    id: newCacheTraceId(),
    at: Date.now(),
    durationMs: 1,
    scope: 'app-1',
    intent: 'render a gauge',
    expectedKey: '',
    threshold: 0.5,
    decision: 'no-match',
    candidates: [],
    reason: 'no candidates in scope',
    ...overrides,
  };
}

describe('createStderrCacheTraceSink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one prefixed JSON line per event to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = createStderrCacheTraceSink();

    sink.emit(makeEvent({ decision: 'no-match', reason: 'judge declined' }));

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]![0] as string;
    expect(line.startsWith('[ggui:cache-trace] ')).toBe(true);
    const parsed = JSON.parse(line.slice('[ggui:cache-trace] '.length)) as Record<
      string,
      unknown
    >;
    expect(parsed['decision']).toBe('no-match');
    expect(parsed['reason']).toBe('judge declined');
    expect(parsed['scope']).toBe('app-1');
  });

  it('projects the optional decision fields when present', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = createStderrCacheTraceSink();

    sink.emit(
      makeEvent({
        decision: 'match-semantic',
        strategy: 'semantic',
        reason: 'judge matched',
        cosineNoveltyDistance: 0.18,
        judgeConfidence: 0.72,
        judgeReason: 'same gauge family',
        winningBlueprintId: 'template:bp-1',
      }),
    );

    const line = spy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line.slice('[ggui:cache-trace] '.length)) as Record<
      string,
      unknown
    >;
    expect(parsed['strategy']).toBe('semantic');
    expect(parsed['cosineNoveltyDistance']).toBe(0.18);
    expect(parsed['judgeConfidence']).toBe(0.72);
    expect(parsed['judgeReason']).toBe('same gauge family');
    expect(parsed['winningBlueprintId']).toBe('template:bp-1');
  });

  it('omits optional fields that are absent on the event', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = createStderrCacheTraceSink();

    // no strategy / cosine / judge fields supplied
    sink.emit(makeEvent({ decision: 'no-match-empty-intent', reason: 'empty intent' }));

    const line = spy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line.slice('[ggui:cache-trace] '.length)) as Record<
      string,
      unknown
    >;
    expect('strategy' in parsed).toBe(false);
    expect('judgeConfidence' in parsed).toBe(false);
    expect('cosineNoveltyDistance' in parsed).toBe(false);
    expect('winningBlueprintId' in parsed).toBe(false);
  });
});

describe('emitCacheTraceEvent env-gated stderr diagnostic', () => {
  afterEach(() => {
    delete process.env['GGUI_CACHE_TRACE_STDERR'];
    setCacheTraceSink(null);
    vi.restoreAllMocks();
  });

  it('self-emits to stderr when GGUI_CACHE_TRACE_STDERR is set, with NO registered sink', () => {
    // The cross-package-singleton-proof path: no setCacheTraceSink call here.
    process.env['GGUI_CACHE_TRACE_STDERR'] = '1';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    emitCacheTraceEvent(makeEvent({ decision: 'no-match', reason: 'judge declined' }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0] as string).toContain('[ggui:cache-trace]');
  });

  it('does NOT emit to stderr when the env is unset and no sink is registered', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    emitCacheTraceEvent(makeEvent());

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('createStdoutJsonCacheTraceSink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits ONE parseable JSON stdout line: msg cache_trace, identity-mapped event fields, flat query fields, schema version', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const sink = createStdoutJsonCacheTraceSink();
    sink.emit(
      makeEvent({
        scope: 'app-42',
        intent: 'a team standup timer',
        decision: 'match-semantic',
        strategy: 'semantic',
        judgeConfidence: 0.95,
        winningBlueprintId: 'bp_win',
        candidates: [
          { key: 'bp_win', score: 0.91, cachedIntent: 'a standup timer' },
          { key: 'bp_other', score: 0.4 },
        ],
        reason: 'judge matched bp_win',
      }),
    );
    expect(writes).toHaveLength(1);
    const line = writes[0]!;
    expect(line.endsWith('\n')).toBe(true);
    const f = JSON.parse(line) as Record<string, unknown>;
    // Log-shipper envelope.
    expect(f.msg).toBe('cache_trace');
    expect(f.level).toBe('info');
    // Identity mapping — event property names verbatim.
    expect(f.scope).toBe('app-42');
    expect(f.intent).toBe('a team standup timer');
    expect(f.decision).toBe('match-semantic');
    expect(f.strategy).toBe('semantic');
    expect(f.judgeConfidence).toBe(0.95);
    expect(f.winningBlueprintId).toBe('bp_win');
    expect(f.reason).toBe('judge matched bp_win');
    // Flat query fields; candidates ride stringified, never nested.
    expect(f.appId).toBe('app-42');
    expect(f.matchedBlueprintId).toBe('bp_win');
    expect(f.topCosine).toBe(0.91);
    expect(f.candidateCount).toBe(2);
    expect(f.candidates).toBeUndefined();
    expect(JSON.parse(f.candidatesJson as string)).toHaveLength(2);
    // Version pin.
    expect(f.traceSchemaVersion).toBe(1);
  });

  it('omits absent optional fields and caps candidatesJson at five while candidateCount reports the real length', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const sink = createStdoutJsonCacheTraceSink();
    sink.emit(
      makeEvent({
        candidates: Array.from({ length: 8 }, (_, i) => ({
          key: `bp_${i}`,
          score: 1 - i / 10,
        })),
      }),
    );
    const f = JSON.parse(writes[0]!) as Record<string, unknown>;
    expect('strategy' in f).toBe(false);
    expect('judgeConfidence' in f).toBe(false);
    expect('winningBlueprintId' in f).toBe(false);
    expect('matchedBlueprintId' in f).toBe(false);
    expect(f.candidateCount).toBe(8);
    expect(JSON.parse(f.candidatesJson as string)).toHaveLength(5);
  });

  it('never throws, even when stdout write explodes', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('boom');
    });
    const sink = createStdoutJsonCacheTraceSink();
    expect(() => sink.emit(makeEvent())).not.toThrow();
  });
});

describe('emitCacheTraceEvent env-gated stdout JSON diagnostic (GGUI_CACHE_TRACE=logger)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['GGUI_CACHE_TRACE'];
    setCacheTraceSink(null);
  });

  it('self-emits the stdout JSON line with NO registered sink — the in-module gate survives module-instance boundaries', () => {
    // The caller-registered path (setCacheTraceSink) is documented as
    // fragile across module-instance boundaries; a deployment armed a
    // caller-registered sink and got ZERO lines from the live process
    // (2026-08-21). The env gate lives INSIDE emitCacheTraceEvent, so
    // it fires from whichever module instance the matcher actually
    // calls — by construction.
    process.env['GGUI_CACHE_TRACE'] = 'logger';
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    emitCacheTraceEvent(makeEvent({ decision: 'match-exact' }));
    const traceLines = writes.filter((w) => w.includes('"cache_trace"'));
    expect(traceLines).toHaveLength(1);
    expect(JSON.parse(traceLines[0]!).decision).toBe('match-exact');
  });

  it('emits nothing when the env is unset or off', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    emitCacheTraceEvent(makeEvent());
    process.env['GGUI_CACHE_TRACE'] = 'off';
    emitCacheTraceEvent(makeEvent());
    expect(writes.filter((w) => w.includes('"cache_trace"'))).toHaveLength(0);
  });
});
