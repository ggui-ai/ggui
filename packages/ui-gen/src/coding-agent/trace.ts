// packages/ui-gen/src/coding-agent/trace.ts
//
// TraceCollector and TurnRecorder for generation investigation.
// Captures full telemetry: prompts, responses, tool executions, timing.

import type {
  GenerationTrace,
  PhaseTrace,
  ToolExecution,
  ToolCall,
  CommitTraceEntry,
} from './types';

// =============================================================================
// TurnRecorder — records a single turn's data
// =============================================================================

export class TurnRecorder {
  private promptData: PhaseTrace['prompt'] | null = null;
  private llmData: PhaseTrace['llmResponse'] | null = null;
  private toolExecs: ToolExecution[] = [];
  private startTime = Date.now();

  constructor(
    private readonly turn: number,
    private readonly phase: 'initial' | 'fix',
  ) {}

  recordPrompt(
    systemPrompt: string,
    userContext: string,
    promptTokens: number,
  ): void {
    this.promptData = { systemPrompt, userContext, promptTokens };
  }

  recordLLMResponse(
    toolCalls: ToolCall[],
    tokens: { input: number; output: number },
    latencyMs: number,
  ): void {
    this.llmData = { toolCalls, tokens, latencyMs };
  }

  recordToolExecution(exec: ToolExecution): void {
    this.toolExecs.push(exec);
  }

  finalize(): PhaseTrace {
    return {
      turn: this.turn,
      phase: this.phase,
      prompt: this.promptData ?? {
        systemPrompt: '',
        userContext: '',
        promptTokens: 0,
      },
      llmResponse: this.llmData ?? {
        toolCalls: [],
        tokens: { input: 0, output: 0 },
        latencyMs: 0,
      },
      toolExecutions: this.toolExecs,
      turnTimeMs: Date.now() - this.startTime,
    };
  }
}

// =============================================================================
// TraceCollector — aggregates all turns
// =============================================================================

export class TraceCollector {
  private phases: PhaseTrace[] = [];
  private commits: CommitTraceEntry[] = [];
  private startTime = Date.now();

  constructor(private readonly traceId: string) {}

  startTurn(turn: number, phase: 'initial' | 'fix'): TurnRecorder {
    const recorder = new TurnRecorder(turn, phase);
    // The recorder will be finalized and its result pushed via finalize()
    // We intercept finalize by wrapping:
    const originalFinalize = recorder.finalize.bind(recorder);
    recorder.finalize = (): PhaseTrace => {
      const phaseTrace = originalFinalize();
      this.phases.push(phaseTrace);
      return phaseTrace;
    };
    return recorder;
  }

  recordCommit(entry: CommitTraceEntry): void {
    this.commits.push(entry);
  }

  build(
    model: string,
    outcome: GenerationTrace['outcome'],
  ): GenerationTrace {
    const initialPhase =
      this.phases.find((p) => p.phase === 'initial') ??
      this.createEmptyPhase(0, 'initial');
    const fixLoopPhases = this.phases.filter((p) => p.phase === 'fix');

    // Token aggregation
    const phase1Tokens = {
      input: initialPhase.llmResponse.tokens.input,
      output: initialPhase.llmResponse.tokens.output,
    };
    const phase2Tokens = fixLoopPhases.reduce(
      (acc, p) => ({
        input: acc.input + p.llmResponse.tokens.input,
        output: acc.output + p.llmResponse.tokens.output,
      }),
      { input: 0, output: 0 },
    );

    const perTurn = this.phases.map((p) => ({
      turn: p.turn,
      input: p.llmResponse.tokens.input,
      output: p.llmResponse.tokens.output,
    }));

    // Time aggregation
    const allToolExecs = this.phases.flatMap((p) => p.toolExecutions);
    const llmCallsMs = this.phases.reduce(
      (sum, p) => sum + p.llmResponse.latencyMs,
      0,
    );
    const toolExecutionMs = allToolExecs.reduce(
      (sum, t) => sum + t.durationMs,
      0,
    );

    return {
      traceId: this.traceId,
      model,
      totalTimeMs: Date.now() - this.startTime,
      phases: {
        initial: initialPhase,
        fixLoop: fixLoopPhases,
      },
      tokenBreakdown: {
        total: {
          input: phase1Tokens.input + phase2Tokens.input,
          output: phase1Tokens.output + phase2Tokens.output,
        },
        phase1: phase1Tokens,
        phase2: phase2Tokens,
        perTurn,
      },
      timeBreakdown: {
        llmCallsMs,
        toolExecutionMs,
        // These are captured at a finer granularity by the caller
        // via tool execution details — we aggregate what we have
        diffProcessingMs: 0,
        buildMs: 0,
        selfCheckMs: 0,
        contextBuildMs: 0,
      },
      commitLog: this.commits,
      outcome,
    };
  }

  private createEmptyPhase(
    turn: number,
    phase: 'initial' | 'fix',
  ): PhaseTrace {
    return {
      turn,
      phase,
      prompt: { systemPrompt: '', userContext: '', promptTokens: 0 },
      llmResponse: {
        toolCalls: [],
        tokens: { input: 0, output: 0 },
        latencyMs: 0,
      },
      toolExecutions: [],
      turnTimeMs: 0,
    };
  }
}
