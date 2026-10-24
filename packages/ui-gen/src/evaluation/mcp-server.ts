// packages/ui-gen/src/evaluation/mcp-server.ts

import type { EvaluationIssue, EvaluationResult } from './types';

/**
 * Input args for the evaluate_score computation.
 * Extracted so unit tests can call the real logic directly.
 */
export interface EvaluateScoreInput {
  completeness: number;
  visualPolish: number;
  interactivity: number;
  accessibility: number;
  codeQuality: number;
  issues: EvaluationIssue[];
  critique?: string;
}

/**
 * Core scoring logic — extracted from the tool handler so it can be
 * unit-tested directly without going through MCP protocol.
 */
export function computeEvaluationScore(
  args: EvaluateScoreInput,
  passThreshold: number
): EvaluationResult {
  const scores = [
    args.completeness,
    args.visualPolish,
    args.interactivity,
    args.accessibility,
    args.codeQuality,
  ];
  const average = scores.reduce((a, b) => a + b, 0) / scores.length;
  const finalScore = Math.round(average * 10) / 10;
  const passed = finalScore >= passThreshold;

  return {
    passed,
    finalScore,
    dimensions: {
      completeness: args.completeness,
      visualPolish: args.visualPolish,
      interactivity: args.interactivity,
      accessibility: args.accessibility,
      codeQuality: args.codeQuality,
    },
    issues: args.issues,
    ...(args.critique && { critique: args.critique }),
  };
}
