import { describe, it, expect } from 'vitest';
import { TraceCollector } from '../trace';

describe('TraceCollector', () => {
  it('startTurn creates a TurnRecorder', () => {
    const tracer = new TraceCollector('trace-1');
    const turn = tracer.startTurn(1, 'initial');
    expect(turn).toBeDefined();
  });

  it('TurnRecorder records prompt, response, and tool executions', () => {
    const tracer = new TraceCollector('trace-1');
    const turn = tracer.startTurn(1, 'initial');

    turn.recordPrompt('system prompt', 'user context', 500);
    turn.recordLLMResponse(
      [{ tool: 'write', input: { code: 'x' } }],
      { input: 100, output: 200 },
      1500,
    );
    turn.recordToolExecution({
      tool: 'write',
      input: { code: 'x' },
      details: { lineCount: 1 },
      result: 'Wrote 1 lines',
      success: true,
      durationMs: 5,
    });

    const phase = turn.finalize();
    expect(phase.turn).toBe(1);
    expect(phase.phase).toBe('initial');
    expect(phase.prompt.systemPrompt).toBe('system prompt');
    expect(phase.prompt.promptTokens).toBe(500);
    expect(phase.llmResponse.toolCalls).toHaveLength(1);
    expect(phase.llmResponse.latencyMs).toBe(1500);
    expect(phase.toolExecutions).toHaveLength(1);
  });

  it('recordCommit stores commit entries', () => {
    const tracer = new TraceCollector('trace-1');
    tracer.recordCommit({
      oid: 'abc1234',
      message: 'initial',
      turn: 1,
      buildPassed: true,
      selfCheckPassed: true,
      violations: [],
      sourceSnapshot: 'const x = 1;',
    });

    const trace = tracer.build('test-model', 'success');
    expect(trace.commitLog).toHaveLength(1);
    expect(trace.commitLog[0].oid).toBe('abc1234');
  });

  it('build produces correct token breakdown', () => {
    const tracer = new TraceCollector('trace-1');

    // Phase 1
    const t1 = tracer.startTurn(1, 'initial');
    t1.recordPrompt('sys', 'user', 100);
    t1.recordLLMResponse([], { input: 100, output: 50 }, 1000);
    t1.finalize();

    // Phase 2 turn 1
    const t2 = tracer.startTurn(2, 'fix');
    t2.recordPrompt('sys', 'user', 200);
    t2.recordLLMResponse([], { input: 200, output: 80 }, 800);
    t2.finalize();

    const trace = tracer.build('test-model', 'success');

    // Token breakdown
    expect(trace.tokenBreakdown.phase1.input).toBe(100);
    expect(trace.tokenBreakdown.phase1.output).toBe(50);
    expect(trace.tokenBreakdown.phase2.input).toBe(200);
    expect(trace.tokenBreakdown.phase2.output).toBe(80);
    expect(trace.tokenBreakdown.total.input).toBe(300);
    expect(trace.tokenBreakdown.total.output).toBe(130);

    // Per-turn
    expect(trace.tokenBreakdown.perTurn).toHaveLength(2);
    expect(trace.tokenBreakdown.perTurn[0]).toEqual({ turn: 1, input: 100, output: 50 });
    expect(trace.tokenBreakdown.perTurn[1]).toEqual({ turn: 2, input: 200, output: 80 });
  });

  it('build produces correct time breakdown', () => {
    const tracer = new TraceCollector('trace-1');

    const t1 = tracer.startTurn(1, 'initial');
    t1.recordPrompt('sys', 'user', 100);
    t1.recordLLMResponse([], { input: 0, output: 0 }, 1000);
    t1.recordToolExecution({
      tool: 'write', input: {}, details: {},
      result: 'ok', success: true, durationMs: 50,
    });
    t1.recordToolExecution({
      tool: 'commit', input: {}, details: {},
      result: 'ok', success: true, durationMs: 200,
    });
    t1.finalize();

    const trace = tracer.build('test-model', 'success');
    expect(trace.timeBreakdown.llmCallsMs).toBe(1000);
    expect(trace.timeBreakdown.toolExecutionMs).toBe(250);
  });

  it('build sets traceId, model, and outcome', () => {
    const tracer = new TraceCollector('trace-42');
    const t = tracer.startTurn(1, 'initial');
    t.recordPrompt('', '', 0);
    t.recordLLMResponse([], { input: 0, output: 0 }, 0);
    t.finalize();

    const trace = tracer.build('claude-sonnet', 'max_turns_fallback');
    expect(trace.traceId).toBe('trace-42');
    expect(trace.model).toBe('claude-sonnet');
    expect(trace.outcome).toBe('max_turns_fallback');
  });

  it('phases.initial and phases.fixLoop are populated correctly', () => {
    const tracer = new TraceCollector('trace-1');

    // Phase 1
    const t1 = tracer.startTurn(1, 'initial');
    t1.recordPrompt('', '', 0);
    t1.recordLLMResponse([], { input: 0, output: 0 }, 0);
    t1.finalize();

    // Phase 2 turns
    const t2 = tracer.startTurn(2, 'fix');
    t2.recordPrompt('', '', 0);
    t2.recordLLMResponse([], { input: 0, output: 0 }, 0);
    t2.finalize();

    const t3 = tracer.startTurn(3, 'fix');
    t3.recordPrompt('', '', 0);
    t3.recordLLMResponse([], { input: 0, output: 0 }, 0);
    t3.finalize();

    const trace = tracer.build('model', 'success');
    expect(trace.phases.initial.turn).toBe(1);
    expect(trace.phases.fixLoop).toHaveLength(2);
    expect(trace.phases.fixLoop[0].turn).toBe(2);
    expect(trace.phases.fixLoop[1].turn).toBe(3);
  });
});
