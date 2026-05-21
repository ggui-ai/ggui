// packages/ui-gen/src/evaluation/message-parsing.ts

/**
 * Shared message parsing utilities for extracting structured data from
 * Claude Agent SDK `query()` messages.
 *
 * These functions are used by evaluator.ts, loop.ts, and generator.ts
 * to capture tool results, source code, and session state from the
 * SDK message stream.
 */

import type { EvaluationResult } from './types';

// ── SDK message type aliases ────────────────────────────────────────

/** A single SDK message from the `query()` async iterator. */
export type SdkMessage = Record<string, unknown>;

/** Content block inside a user or assistant message. */
type ContentBlock = Record<string, unknown>;

/** A text item inside a tool_result content array. */
interface TextItem {
  type?: string;
  text?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract tool_result text items from a user-type SDK message.
 * Returns an empty array if the message isn't a user message or has no tool results.
 */
export function extractToolResultTexts(message: SdkMessage): string[] {
  if ((message.type as string) !== 'user') return [];

  const texts: string[] = [];
  const innerMessage = message.message as SdkMessage | undefined;
  const messageContent = innerMessage?.content as ContentBlock[] | undefined;

  if (!Array.isArray(messageContent)) return texts;

  for (const contentItem of messageContent) {
    if (contentItem.type === 'tool_result') {
      const toolResultContent = contentItem.content as TextItem[] | undefined;
      if (Array.isArray(toolResultContent)) {
        for (const textItem of toolResultContent) {
          if (textItem.type === 'text' && textItem.text) {
            texts.push(textItem.text);
          }
        }
      }
    }
  }

  return texts;
}

// ── EvaluationResult extraction ─────────────────────────────────────

/**
 * Extract an `EvaluationResult` from an array of SDK messages.
 *
 * Scans for user messages containing a tool_result with JSON that has
 * `finalScore` (number) and `dimensions` fields. Returns the last
 * matching result, or `undefined` if none found.
 *
 * Used by: evaluator.ts
 */
export function extractEvalResult(messages: SdkMessage[]): EvaluationResult | undefined {
  let evalResult: EvaluationResult | undefined;

  for (const message of messages) {
    const msgStr = JSON.stringify(message);
    if (!msgStr.includes('finalScore') || !msgStr.includes('dimensions')) continue;

    for (const text of extractToolResultTexts(message)) {
      if (!text.includes('finalScore')) continue;
      try {
        const parsed = JSON.parse(text) as EvaluationResult;
        if (typeof parsed.finalScore === 'number' && parsed.dimensions) {
          evalResult = parsed;
        }
      } catch {
        // Not valid JSON
      }
    }
  }

  return evalResult;
}

// ── compiledCode extraction ─────────────────────────────────────────

/**
 * Extract `compiledCode` from a single SDK message.
 *
 * Tries two strategies:
 * 1. Regex extraction from the full serialized message (fallback)
 * 2. Structured extraction from user/tool_result content
 *
 * Returns the extracted code or `undefined`.
 *
 * Used by: loop.ts, generator.ts
 */
export function extractCompiledCodeFromMessage(message: SdkMessage): string | undefined {
  const msgStr = JSON.stringify(message);
  if (!msgStr.includes('compiledCode')) return undefined;

  // Strategy 1: Regex fallback (catches compiledCode in any position)
  let regexCode: string | undefined;
  const match = msgStr.match(/"compiledCode"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/);
  if (match) {
    try {
      regexCode = JSON.parse(`"${match[1]}"`);
    } catch {
      // Not parseable
    }
  }

  // Strategy 2: Structured extraction from tool_result
  for (const text of extractToolResultTexts(message)) {
    if (!text.includes('compiledCode')) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed.success && parsed.compiledCode) {
        return parsed.compiledCode; // Prefer structured over regex
      }
    } catch {
      // Not JSON
    }
  }

  return regexCode;
}

// ── sourceCode extraction ───────────────────────────────────────────

/**
 * Extract source code from an assistant's Write tool_use message.
 *
 * Looks for `tool_use` blocks with `name === 'Write'` and returns
 * the `input.content` string. If multiple Write calls exist, returns
 * the last one (the final version).
 *
 * Used by: loop.ts, generator.ts
 */
export function extractSourceCodeFromMessage(message: SdkMessage): string | undefined {
  if ((message.type as string) !== 'assistant') return undefined;

  let sourceCode: string | undefined;
  const betaMessage = message.message as SdkMessage | undefined;
  const content = betaMessage?.content as ContentBlock[] | undefined;

  if (!Array.isArray(content)) return undefined;

  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'Write') {
      const input = block.input as { content?: string } | undefined;
      if (input?.content) {
        sourceCode = input.content;
      }
    }
  }

  return sourceCode;
}

// ── Batch helpers ───────────────────────────────────────────────────

/**
 * Scan all messages for the last compiledCode value.
 *
 * Convenience wrapper for tests and one-shot extraction.
 */
export function extractCompiledCode(messages: SdkMessage[]): string | undefined {
  let compiledCode: string | undefined;
  for (const message of messages) {
    const code = extractCompiledCodeFromMessage(message);
    if (code) compiledCode = code;
  }
  return compiledCode;
}

/**
 * Scan all messages for the last sourceCode from Write tool_use.
 *
 * Convenience wrapper for tests and one-shot extraction.
 */
export function extractSourceCode(messages: SdkMessage[]): string | undefined {
  let sourceCode: string | undefined;
  for (const message of messages) {
    const code = extractSourceCodeFromMessage(message);
    if (code) sourceCode = code;
  }
  return sourceCode;
}
