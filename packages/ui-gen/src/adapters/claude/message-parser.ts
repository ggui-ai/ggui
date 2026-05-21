// packages/ui-gen/src/adapters/claude/message-parser.ts
//
// Focused helpers for extracting artifacts from Claude Agent SDK messages.
// Each function handles one extraction concern, keeping the main loop clean.
//
// Uses proper discriminated union narrowing on SDKMessage variants.

import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { JsonObject } from '@ggui-ai/protocol';

/**
 * Mutable accumulator for artifacts extracted from the SDK message stream.
 */
export interface MessageArtifacts {
  compiledCode: string;
  sourceCode: string | undefined;
  stream: JsonObject | undefined;
  generatorMeta: { category: string; description: string } | undefined;
  sdkSessionId: string | undefined;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number | undefined;
  subagentsUsed: string[];
}

export function createArtifacts(): MessageArtifacts {
  return {
    compiledCode: '',
    sourceCode: undefined,
    stream: undefined,
    generatorMeta: undefined,
    sdkSessionId: undefined,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: undefined,
    subagentsUsed: [],
  };
}

/** Progress event emitted during generation. */
export type ProgressEvent = { type: string; [key: string]: string | number | boolean | undefined };

/**
 * Process a single SDK message and update artifacts accordingly.
 */
export function processMessage(
  message: SDKMessage,
  artifacts: MessageArtifacts,
  onProgress?: (event: ProgressEvent) => void,
  maxTurns?: number,
): void {
  extractSessionId(message, artifacts);
  trackTurns(message, artifacts, onProgress, maxTurns);
  trackTokenUsage(message, artifacts);
  extractCompiledCode(message, artifacts, onProgress);
  extractSourceCode(message, artifacts);
  extractStreamSpec(message, artifacts);
  extractGeneratorMeta(message, artifacts);
}

// ── Individual extractors ────────────────────────────────────────────

function extractSessionId(message: SDKMessage, artifacts: MessageArtifacts): void {
  if (message.type !== 'system') return;
  const systemMsg = message as SDKSystemMessage;
  if (systemMsg.subtype === 'init') {
    artifacts.sdkSessionId = systemMsg.session_id;
  }
}

function trackTurns(
  message: SDKMessage,
  artifacts: MessageArtifacts,
  onProgress?: (event: ProgressEvent) => void,
  maxTurns?: number,
): void {
  if (message.type !== 'assistant') return;
  const assistantMsg = message as SDKAssistantMessage;
  artifacts.turnCount++;

  const contentBlocks = assistantMsg.message?.content;
  if (Array.isArray(contentBlocks)) {
    for (const block of contentBlocks) {
      if (block.type === 'tool_use') {
        onProgress?.({ type: 'tool_call', tool: block.name || 'unknown' });
      }
    }
  }
  onProgress?.({ type: 'turn', turn: artifacts.turnCount, maxTurns: maxTurns ?? 0 });
}

function trackTokenUsage(message: SDKMessage, artifacts: MessageArtifacts): void {
  if (message.type !== 'result') return;
  const resultMsg = message as SDKResultMessage;

  if (resultMsg.subtype === 'success') {
    const usage = resultMsg.usage;
    artifacts.inputTokens = usage.input_tokens || 0;
    artifacts.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    artifacts.cacheReadTokens = usage.cache_read_input_tokens || 0;
    artifacts.outputTokens = usage.output_tokens || 0;
    artifacts.estimatedCostUsd = resultMsg.total_cost_usd;
  }
}

function extractCompiledCode(
  message: SDKMessage,
  artifacts: MessageArtifacts,
  onProgress?: (event: ProgressEvent) => void,
): void {
  if (artifacts.compiledCode) return; // Already found

  const msgStr = JSON.stringify(message);
  if (!msgStr.includes('compiledCode')) return;

  // Strategy 1: regex extraction from anywhere in the message
  const match = msgStr.match(/"compiledCode"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/);
  if (match) {
    try {
      artifacts.compiledCode = JSON.parse(`"${match[1]}"`);
      onProgress?.({ type: 'compiled', bytes: artifacts.compiledCode.length });
      return;
    } catch {
      // Fall through to structured extraction
    }
  }

  // Strategy 2: structured extraction from tool_result content
  if (message.type === 'user') {
    const userMsg = message as SDKUserMessage;
    const code = extractFromToolResults(userMsg);
    if (code) artifacts.compiledCode = code;
  }
}

/**
 * Walk the nested tool_result structures to find compiledCode.
 */
function extractFromToolResults(message: SDKUserMessage): string | undefined {
  const content = message.message?.content;
  if (!Array.isArray(content)) return undefined;

  for (const item of content) {
    if (typeof item === 'object' && item !== null && 'type' in item && item.type === 'tool_result') {
      const toolResultItem = item as { type: 'tool_result'; content?: unknown };
      const code = parseCompiledCodeFromContent(toolResultItem.content);
      if (code) return code;
    }
  }

  return undefined;
}

function parseCompiledCodeFromContent(content: unknown): string | undefined {
  if (Array.isArray(content)) {
    for (const item of content) {
      const textItem = item as { type?: string; text?: string };
      if (textItem.type === 'text' && textItem.text?.includes('compiledCode')) {
        const code = tryParseCompiledCode(textItem.text);
        if (code) return code;
      }
    }
  }
  if (typeof content === 'string' && content.includes('compiledCode')) {
    return tryParseCompiledCode(content);
  }
  return undefined;
}

function tryParseCompiledCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text);
    if (parsed.success && parsed.compiledCode) return parsed.compiledCode;
  } catch {
    // Not valid JSON
  }
  return undefined;
}

function extractSourceCode(message: SDKMessage, artifacts: MessageArtifacts): void {
  if (message.type !== 'assistant') return;
  const assistantMsg = message as SDKAssistantMessage;

  const content = assistantMsg.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'Write') {
      const input = block.input as { content?: string } | undefined;
      if (input?.content) {
        artifacts.sourceCode = input.content;
      }
    }
  }
}

/**
 * Unescape a JSON string that was double-escaped inside another JSON string.
 */
function unescapeJsonString(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * Extract a delimited marker from a JSON-stringified message.
 * Returns the raw content between START and END markers, or undefined.
 */
function extractMarker(msgStr: string, startMarker: string, endMarker: string): string | undefined {
  if (!msgStr.includes(startMarker)) return undefined;
  const match = msgStr.match(new RegExp(`${startMarker}\\s*([\\s\\S]*?)\\s*${endMarker}`));
  return match?.[1];
}

function extractStreamSpec(message: SDKMessage, artifacts: MessageArtifacts): void {
  if (artifacts.stream) return;

  const raw = extractMarker(JSON.stringify(message), '__GGUI_STREAM_SPEC__', '__GGUI_STREAM_SPEC_END__');
  if (!raw) return;

  try {
    artifacts.stream = JSON.parse(unescapeJsonString(raw));
  } catch {
    // Failed to parse
  }
}

function extractGeneratorMeta(message: SDKMessage, artifacts: MessageArtifacts): void {
  if (artifacts.generatorMeta) return;

  const raw = extractMarker(JSON.stringify(message), '__GGUI_META__', '__GGUI_META_END__');
  if (!raw) return;

  try {
    const stripped = raw.replace(/```(?:json)?\s*/g, '').trim();
    const parsed = JSON.parse(unescapeJsonString(stripped)) as { category?: string; description?: string };
    if (parsed.category) {
      artifacts.generatorMeta = {
        category: parsed.category,
        description: parsed.description ?? '',
      };
    }
  } catch {
    // Failed to parse
  }
}
