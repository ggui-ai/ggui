import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createStderrCacheTraceSink,
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
