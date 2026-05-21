// packages/ui-gen/src/adapters/extract-code.ts
//
// Shared helpers for extracting artifacts from tool call results
// and LLM text output. Used by all adapters to avoid duplication.

import * as esbuild from 'esbuild';
import type { ToolDefinition, ToolResult } from './types';
import type { JsonObject } from '@ggui-ai/protocol';

/**
 * Mutable state bag passed through the agentic loop.
 * Each adapter creates one of these and passes it to the
 * extraction helpers on every tool call and text output.
 */
export interface CodeCapture {
  compiledCode: string;
  sourceCode: string | undefined;
  stream: JsonObject | undefined;
  generatorMeta: { category: string; description: string } | undefined;
}

export function createCapture(): CodeCapture {
  return { compiledCode: '', sourceCode: undefined, stream: undefined, generatorMeta: undefined };
}

/**
 * Before calling a tool handler: capture source code if this is
 * a compile_component call.
 */
export function captureSourceCode(
  capture: CodeCapture,
  toolName: string,
  args: JsonObject,
): void {
  if (toolName === 'compile_component' && typeof args.code === 'string') {
    capture.sourceCode = args.code;
  }
}

/**
 * After a tool handler returns: extract compiled code if this was
 * a successful compile_component call.
 */
export function captureCompiledCode(
  capture: CodeCapture,
  toolName: string,
  result: ToolResult,
): void {
  if (toolName !== 'compile_component' || result.isError) return;

  try {
    const parsed = JSON.parse(result.content[0].text);
    if (parsed.success && parsed.compiledCode) {
      capture.compiledCode = parsed.compiledCode;
    }
  } catch {
    // Not parseable — ignore
  }
}

/**
 * Scan text output for __GGUI_STREAM_SPEC__ and __GGUI_META__ markers.
 * Called on each text block in assistant messages (raw adapters)
 * or on the full message stream (SDK adapters via message-parser).
 */
export function captureMarkers(capture: CodeCapture, text: string): void {
  if (!capture.stream && text.includes('__GGUI_STREAM_SPEC__')) {
    const match = text.match(/__GGUI_STREAM_SPEC__\s*([\s\S]*?)\s*__GGUI_STREAM_SPEC_END__/);
    if (match) {
      try {
        capture.stream = JSON.parse(
          match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
        );
      } catch { /* ignore */ }
    }
  }

  if (!capture.generatorMeta && text.includes('__GGUI_META__')) {
    const match = text.match(/__GGUI_META__\s*([\s\S]*?)\s*__GGUI_META_END__/);
    if (match) {
      try {
        const stripped = match[1].replace(/```(?:json)?\s*/g, '').trim();
        const raw = stripped.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const parsed = JSON.parse(raw) as { category?: string; description?: string };
        if (parsed.category) {
          capture.generatorMeta = { category: parsed.category, description: parsed.description ?? '' };
        }
      } catch { /* ignore */ }
    }
  }
}

/**
 * Fallback: try to extract code from a text output (used by OpenAI SDK
 * adapter when the model writes code as text instead of calling tools).
 */
export async function extractCodeFromText(
  finalOutput: string,
  tools: ToolDefinition[],
  capture: CodeCapture,
): Promise<void> {
  if (finalOutput.length <= 100) return;

  const codeMatch =
    finalOutput.match(/```(?:tsx?|jsx?|typescript|javascript)?\s*\n([\s\S]*?)```/) ??
    finalOutput.match(/```\s*\n([\s\S]*?)```/);
  let code = codeMatch ? codeMatch[1].trim() : '';

  if (!code && (finalOutput.includes('export default') || finalOutput.includes('export function'))) {
    code = finalOutput;
  }

  if (!code || !(code.includes('export default') || code.includes('export function'))) {
    return;
  }

  capture.sourceCode = code;
  const compileTool = tools.find((t) => t.name === 'compile_component');
  if (!compileTool) return;

  const compileResult = await compileTool.handler({ code, filename: 'Component.tsx' });
  if (compileResult.isError) {
    console.warn('[extractCodeFromText] compile_component failed:', compileResult.content[0]?.text?.slice(0, 300));
  }
  captureCompiledCode(capture, 'compile_component', compileResult);
}

/**
 * Last-resort compilation: bypass self-checks and compile directly with esbuild.
 *
 * Used when compile_component kept rejecting code due to self-check violations
 * (hex colors, raw pixels, forbidden imports, etc.) but the model DID produce
 * source code. Getting imperfect compiled code is better than getting nothing.
 *
 * Also tries text output as a source if sourceCode is empty.
 */
export async function compileLastResort(
  capture: CodeCapture,
  allTextOutput?: string,
): Promise<void> {
  if (capture.compiledCode) return; // Already have compiled code

  // Try capture.sourceCode first (from compile_component calls that failed self-checks)
  let code = capture.sourceCode;

  // Fallback: extract from text output
  if (!code && allTextOutput && allTextOutput.length > 100) {
    const codeMatch =
      allTextOutput.match(/```(?:tsx?|jsx?|typescript|javascript)?\s*\n([\s\S]*?)```/) ??
      allTextOutput.match(/```\s*\n([\s\S]*?)```/);
    code = codeMatch ? codeMatch[1].trim() : undefined;

    if (!code && (allTextOutput.includes('export default') || allTextOutput.includes('export function'))) {
      code = allTextOutput;
    }
  }

  if (!code || !(code.includes('export default') || code.includes('export function'))) {
    return;
  }

  try {
    const result = await esbuild.transform(code, {
      loader: 'tsx',
      target: 'es2020',
      format: 'esm',
      jsx: 'automatic',
      jsxImportSource: 'react',
      minify: true,
      sourcefile: 'Component.tsx',
    });

    capture.compiledCode = result.code;
    capture.sourceCode = code;
    console.warn('[compileLastResort] Compiled code bypassing self-checks — may have quality issues');
  } catch (err) {
    console.warn('[compileLastResort] esbuild failed:', err instanceof Error ? err.message : String(err));
  }
}
