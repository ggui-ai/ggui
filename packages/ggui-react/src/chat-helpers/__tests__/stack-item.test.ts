import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '@ggui-ai/protocol';
import {
  extractStackItemFromToolResult,
  extractSessionIdFromToolResult,
} from '../stack-item';

function toolResult(content: unknown): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'tu_1',
    content,
  } as ContentBlock;
}

describe('extractStackItemFromToolResult', () => {
  it('returns null for non-tool_result blocks', () => {
    const text: ContentBlock = { type: 'text', text: 'hi' };
    expect(extractStackItemFromToolResult(text)).toBeNull();
  });

  it('returns null when content is not an object', () => {
    expect(extractStackItemFromToolResult(toolResult('string payload'))).toBeNull();
    expect(extractStackItemFromToolResult(toolResult(null))).toBeNull();
  });

  it('picks up the direct StackItem shape', () => {
    const item = { id: 'cmp_1', componentCode: 'export default () => null', props: {} };
    expect(extractStackItemFromToolResult(toolResult(item))).toBe(item);
  });

  it('picks up the wrapped shape { stackItem }', () => {
    const item = { id: 'cmp_2', componentCode: 'x' };
    expect(extractStackItemFromToolResult(toolResult({ stackItem: item }))).toBe(item);
  });

  it('picks up the nested wrapped shape { result: { stackItem } }', () => {
    const item = { id: 'cmp_3', componentCode: 'x' };
    expect(
      extractStackItemFromToolResult(toolResult({ result: { stackItem: item } })),
    ).toBe(item);
  });

  it('picks up the nested direct shape { result: { id, componentCode } }', () => {
    const item = { id: 'cmp_4', componentCode: 'x' };
    expect(extractStackItemFromToolResult(toolResult({ result: item }))).toBe(item);
  });

  it('returns null when no stack-item-shaped object is present', () => {
    expect(
      extractStackItemFromToolResult(toolResult({ sessionId: 's1', foo: 'bar' })),
    ).toBeNull();
  });
});

describe('extractSessionIdFromToolResult', () => {
  it('returns null for non-tool_result blocks', () => {
    const text: ContentBlock = { type: 'text', text: 'hi' };
    expect(extractSessionIdFromToolResult(text)).toBeNull();
  });

  it('reads a top-level sessionId', () => {
    expect(extractSessionIdFromToolResult(toolResult({ sessionId: 'sess_42' }))).toBe(
      'sess_42',
    );
  });

  it('reads a nested sessionId one level deep', () => {
    expect(
      extractSessionIdFromToolResult(toolResult({ result: { sessionId: 'sess_7' } })),
    ).toBe('sess_7');
  });

  it('returns null when no sessionId is anywhere', () => {
    expect(
      extractSessionIdFromToolResult(toolResult({ id: 'cmp_1', componentCode: 'x' })),
    ).toBeNull();
  });
});
