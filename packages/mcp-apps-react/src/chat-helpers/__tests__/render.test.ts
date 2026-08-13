import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '@ggui-ai/protocol';
import {
  extractRenderFromToolResult,
  extractSessionIdFromToolResult,
} from '../render';

function toolResult(content: unknown): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'tu_1',
    content,
  } as ContentBlock;
}

describe('extractRenderFromToolResult', () => {
  it('returns null for non-tool_result blocks', () => {
    const text: ContentBlock = { type: 'text', text: 'hi' };
    expect(extractRenderFromToolResult(text)).toBeNull();
  });

  it('returns null when content is not an object', () => {
    expect(extractRenderFromToolResult(toolResult('string payload'))).toBeNull();
    expect(extractRenderFromToolResult(toolResult(null))).toBeNull();
  });

  it('picks up the direct GguiSession shape', () => {
    const item = { id: 'cmp_1', componentCode: 'export default () => null', props: {} };
    expect(extractRenderFromToolResult(toolResult(item))).toBe(item);
  });

  it('picks up the wrapped shape { render }', () => {
    const item = { id: 'cmp_2', componentCode: 'x' };
    expect(extractRenderFromToolResult(toolResult({ render: item }))).toBe(item);
  });

  it('picks up the nested wrapped shape { result: { render } }', () => {
    const item = { id: 'cmp_3', componentCode: 'x' };
    expect(
      extractRenderFromToolResult(toolResult({ result: { render: item } })),
    ).toBe(item);
  });

  it('picks up the nested direct shape { result: { id, componentCode } }', () => {
    const item = { id: 'cmp_4', componentCode: 'x' };
    expect(extractRenderFromToolResult(toolResult({ result: item }))).toBe(item);
  });

  it('returns null when no render-shaped object is present', () => {
    expect(
      extractRenderFromToolResult(toolResult({ sessionId: 'r1', foo: 'bar' })),
    ).toBeNull();
  });
});

describe('extractSessionIdFromToolResult', () => {
  it('returns null for non-tool_result blocks', () => {
    const text: ContentBlock = { type: 'text', text: 'hi' };
    expect(extractSessionIdFromToolResult(text)).toBeNull();
  });

  it('reads a top-level sessionId', () => {
    expect(extractSessionIdFromToolResult(toolResult({ sessionId: 'session_42' }))).toBe(
      'session_42',
    );
  });

  it('reads a nested sessionId one level deep', () => {
    expect(
      extractSessionIdFromToolResult(toolResult({ result: { sessionId: 'session_7' } })),
    ).toBe('session_7');
  });

  it('returns null when no sessionId is anywhere', () => {
    expect(
      extractSessionIdFromToolResult(toolResult({ id: 'cmp_1', componentCode: 'x' })),
    ).toBeNull();
  });
});
