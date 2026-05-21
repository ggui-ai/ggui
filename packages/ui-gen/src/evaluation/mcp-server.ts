// packages/ui-gen/src/evaluation/mcp-server.ts

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
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

/**
 * Create the evaluation MCP server with the evaluate_score tool.
 *
 * The evaluator LLM provides qualitative scores per dimension.
 * This tool handles the arithmetic (average, pass/fail) so the LLM
 * doesn't need to do math.
 */
export function createEvaluationToolsServer(passThreshold = 70) {
  return createSdkMcpServer({
    name: 'eval-tools',
    version: '1.0.0',
    tools: [
      tool(
        'evaluate_score',
        'Compute evaluation score from dimension ratings. Call this after analyzing the component code against all 5 dimensions.',
        {
          completeness: z.number().min(0).max(100).describe('Score for feature completeness (0-100)'),
          visualPolish: z.number().min(0).max(100).describe('Score for visual polish and design (0-100)'),
          interactivity: z.number().min(0).max(100).describe('Score for interactivity and state management (0-100)'),
          accessibility: z.number().min(0).max(100).describe('Score for accessibility (ARIA, keyboard nav, contrast) (0-100)'),
          codeQuality: z.number().min(0).max(100).describe('Score for code quality and structure (0-100)'),
          issues: z.array(
            z.object({
              dimension: z.string().describe('Which dimension this issue affects'),
              description: z.string().describe('What the issue is'),
              severity: z.enum(['critical', 'major', 'minor']).describe('Issue severity'),
              fix: z.string().describe('How to fix this issue'),
            })
          ).describe('List of specific issues found'),
          critique: z.string().optional().describe('Optional overall critique summary'),
        },
        async (args) => {
          const result = computeEvaluationScore(args, passThreshold);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
      ),
    ],
  });
}
