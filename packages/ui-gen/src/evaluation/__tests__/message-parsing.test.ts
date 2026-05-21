/**
 * Tests for the shared message parsing functions in message-parsing.ts.
 *
 * These test the REAL functions used by evaluator.ts and loop.ts,
 * ensuring extraction logic is correct without requiring API calls.
 */
import { describe, it, expect } from 'vitest';
import {
  extractEvalResult,
  extractCompiledCode,
  extractCompiledCodeFromMessage,
  extractSourceCode,
  extractSourceCodeFromMessage,
  extractToolResultTexts,
} from '../message-parsing';
import type { SdkMessage } from '../message-parsing';
import type { EvaluationResult } from '../types';

// --- Test data: synthetic SDK messages ---

function makeEvalToolResultMessage(evalResult: EvaluationResult): SdkMessage {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool_abc123',
          content: [
            {
              type: 'text',
              text: JSON.stringify(evalResult, null, 2),
            },
          ],
        },
      ],
    },
  };
}

function makeCompileToolResultMessage(compiledCode: string, success = true): SdkMessage {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool_compile123',
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success, compiledCode, warnings: [] }),
            },
          ],
        },
      ],
    },
  };
}

function makeWriteToolUseMessage(sourceCode: string): SdkMessage {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/workspace/Component.tsx', content: sourceCode },
        },
      ],
    },
  };
}

function makeSystemInitMessage(sessionId: string): SdkMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    mcp_servers: [{ name: 'eval-tools', status: 'connected' }],
  };
}

function makeResultMessage(): SdkMessage {
  return {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 500, output_tokens: 200 },
    total_cost_usd: 0.01,
  };
}

function makeAssistantTextMessage(text: string): SdkMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  };
}

// ========================================================================
// extractToolResultTexts
// ========================================================================

describe('extractToolResultTexts', () => {
  it('extracts text from user tool_result messages', () => {
    const msg = makeCompileToolResultMessage('code here');
    const texts = extractToolResultTexts(msg);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('compiledCode');
  });

  it('returns empty array for non-user messages', () => {
    expect(extractToolResultTexts(makeAssistantTextMessage('hello'))).toEqual([]);
    expect(extractToolResultTexts(makeSystemInitMessage('s1'))).toEqual([]);
    expect(extractToolResultTexts(makeResultMessage())).toEqual([]);
  });

  it('returns empty array for user messages without tool_result', () => {
    const msg: SdkMessage = {
      type: 'user',
      message: { content: [{ type: 'text', text: 'hello' }] },
    };
    expect(extractToolResultTexts(msg)).toEqual([]);
  });

  it('handles multiple tool_results in one message', () => {
    const msg: SdkMessage = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: [{ type: 'text', text: 'result1' }],
          },
          {
            type: 'tool_result',
            content: [{ type: 'text', text: 'result2' }],
          },
        ],
      },
    };
    const texts = extractToolResultTexts(msg);
    expect(texts).toEqual(['result1', 'result2']);
  });
});

// ========================================================================
// extractEvalResult
// ========================================================================

describe('extractEvalResult', () => {
  it('extracts a passing result from tool_result message', () => {
    const expected: EvaluationResult = {
      passed: true,
      finalScore: 85,
      dimensions: {
        completeness: 90,
        visualPolish: 80,
        interactivity: 85,
        accessibility: 80,
        codeQuality: 90,
      },
      issues: [],
    };

    const messages = [
      makeSystemInitMessage('session-1'),
      makeAssistantTextMessage('Let me evaluate...'),
      makeEvalToolResultMessage(expected),
      makeResultMessage(),
    ];

    const result = extractEvalResult(messages);
    expect(result).toBeDefined();
    expect(result!.passed).toBe(true);
    expect(result!.finalScore).toBe(85);
    expect(result!.dimensions.completeness).toBe(90);
    expect(result!.issues).toEqual([]);
  });

  it('extracts a failing result with issues', () => {
    const expected: EvaluationResult = {
      passed: false,
      finalScore: 55,
      dimensions: {
        completeness: 40,
        visualPolish: 60,
        interactivity: 50,
        accessibility: 65,
        codeQuality: 60,
      },
      issues: [
        { dimension: 'completeness', description: 'Missing submit', severity: 'critical', fix: 'Add button' },
      ],
      critique: 'Needs work',
    };

    const messages = [
      makeEvalToolResultMessage(expected),
      makeResultMessage(),
    ];

    const result = extractEvalResult(messages);
    expect(result).toBeDefined();
    expect(result!.passed).toBe(false);
    expect(result!.finalScore).toBe(55);
    expect(result!.issues).toHaveLength(1);
    expect(result!.critique).toBe('Needs work');
  });

  it('returns undefined when no eval result in messages', () => {
    const messages = [
      makeSystemInitMessage('session-1'),
      makeAssistantTextMessage('No tool call'),
      makeResultMessage(),
    ];

    expect(extractEvalResult(messages)).toBeUndefined();
  });

  it('ignores messages with finalScore in non-tool_result context', () => {
    const messages = [
      makeAssistantTextMessage('The finalScore and dimensions look good'),
    ];

    expect(extractEvalResult(messages)).toBeUndefined();
  });

  it('handles malformed JSON in tool_result gracefully', () => {
    const messages: SdkMessage[] = [
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: [
                { type: 'text', text: '{ "finalScore": bad json, "dimensions": {} }' },
              ],
            },
          ],
        },
      },
    ];

    expect(extractEvalResult(messages)).toBeUndefined();
  });

  it('requires both finalScore as number and dimensions object', () => {
    const messages: SdkMessage[] = [
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: [
                { type: 'text', text: JSON.stringify({ finalScore: 'not a number', dimensions: {} }) },
              ],
            },
          ],
        },
      },
    ];

    expect(extractEvalResult(messages)).toBeUndefined();
  });
});

// ========================================================================
// extractCompiledCode / extractCompiledCodeFromMessage
// ========================================================================

describe('extractCompiledCode', () => {
  it('extracts compiledCode from compile_component tool_result', () => {
    const code = 'import{jsx}from"react/jsx-runtime";export default function GeneratedComponent(){return jsx("div",{})}';
    const messages = [makeCompileToolResultMessage(code)];

    expect(extractCompiledCode(messages)).toBe(code);
  });

  it('extracts compiledCode with escaped characters', () => {
    const code = 'import{jsx}from"react/jsx-runtime";export default function C(){return jsx("div",{children:"Hello \\"world\\""})}';
    const messages = [makeCompileToolResultMessage(code)];

    const result = extractCompiledCode(messages);
    expect(result).toBeDefined();
    expect(result).toContain('jsx-runtime');
  });

  it('returns undefined when no compiledCode in messages', () => {
    const messages = [
      makeSystemInitMessage('s1'),
      makeResultMessage(),
    ];

    expect(extractCompiledCode(messages)).toBeUndefined();
  });

  it('ignores failed compilation', () => {
    const messages: SdkMessage[] = [
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: [
                { type: 'text', text: JSON.stringify({ success: false, error: 'Syntax error' }) },
              ],
            },
          ],
        },
      },
    ];

    expect(extractCompiledCode(messages)).toBeUndefined();
  });

  it('prefers structured tool_result over regex fallback', () => {
    // A single message that has compiledCode in both positions
    const msg = makeCompileToolResultMessage('structured-code');
    const result = extractCompiledCodeFromMessage(msg);
    expect(result).toBe('structured-code');
  });

  it('returns last compiledCode when multiple exist', () => {
    const messages = [
      makeCompileToolResultMessage('first-version'),
      makeCompileToolResultMessage('second-version'),
    ];
    expect(extractCompiledCode(messages)).toBe('second-version');
  });
});

// ========================================================================
// extractSourceCode / extractSourceCodeFromMessage
// ========================================================================

describe('extractSourceCode', () => {
  it('extracts source code from Write tool_use block', () => {
    const source = 'export default function GeneratedComponent() { return <div>Hello</div>; }';
    const messages = [makeWriteToolUseMessage(source)];

    expect(extractSourceCode(messages)).toBe(source);
  });

  it('takes the last Write call when multiple exist', () => {
    const messages = [
      makeWriteToolUseMessage('first version'),
      makeWriteToolUseMessage('second version'),
    ];

    expect(extractSourceCode(messages)).toBe('second version');
  });

  it('returns undefined when no Write tool_use exists', () => {
    const messages: SdkMessage[] = [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/foo' } }],
        },
      },
    ];

    expect(extractSourceCode(messages)).toBeUndefined();
  });

  it('ignores non-assistant messages', () => {
    expect(extractSourceCodeFromMessage(makeSystemInitMessage('s1'))).toBeUndefined();
    expect(extractSourceCodeFromMessage(makeResultMessage())).toBeUndefined();
    expect(extractSourceCodeFromMessage(makeCompileToolResultMessage('code'))).toBeUndefined();
  });
});

// ========================================================================
// session_id extraction (pattern verification)
// ========================================================================

describe('session_id extraction from init message', () => {
  it('extracts session_id from init message', () => {
    const msg = makeSystemInitMessage('my-session-123');
    // This mirrors the generator.ts extraction pattern:
    // sdkSessionId = msgDetails.session_id as string | undefined;
    if (msg.type === 'system' && (msg as SdkMessage).subtype === 'init') {
      const sessionId = (msg as SdkMessage).session_id as string | undefined;
      expect(sessionId).toBe('my-session-123');
    }
  });
});
