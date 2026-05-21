import type { ContentBlock } from '@ggui-ai/protocol';

/**
 * Pull a durable StackItem-shaped object out of a `tool_result` block's
 * `content` payload. Tolerant of shapes:
 *   - Direct: { id, componentCode, props, ... }                (StackItem itself)
 *   - Wrapped: { stackItem: {...} }
 *   - Nested: { result: { stackItem: {...} } }
 *   - Nested direct: { result: { id, componentCode, ... } }
 *
 * Returns `null` if no StackItem can be found — caller falls back to
 * placeholder rendering.
 */
export function extractStackItemFromToolResult(block: ContentBlock): unknown | null {
  if (block.type !== 'tool_result') return null;
  const content = block.content as unknown;
  if (typeof content !== 'object' || content === null) return null;
  const rec = content as Record<string, unknown>;
  if (rec.stackItem && typeof rec.stackItem === 'object') return rec.stackItem;
  if (typeof rec.id === 'string' && typeof rec.componentCode === 'string') return rec;
  for (const v of Object.values(rec)) {
    if (typeof v === 'object' && v !== null) {
      const inner = v as Record<string, unknown>;
      if (inner.stackItem && typeof inner.stackItem === 'object') return inner.stackItem;
      if (typeof inner.id === 'string' && typeof inner.componentCode === 'string') return inner;
    }
  }
  return null;
}

/** Same traversal looking for just a sessionId field. */
export function extractSessionIdFromToolResult(block: ContentBlock): string | null {
  if (block.type !== 'tool_result') return null;
  const content = block.content as unknown;
  if (typeof content !== 'object' || content === null) return null;
  const rec = content as Record<string, unknown>;
  if (typeof rec.sessionId === 'string') return rec.sessionId;
  for (const v of Object.values(rec)) {
    if (typeof v === 'object' && v !== null) {
      const inner = v as Record<string, unknown>;
      if (typeof inner.sessionId === 'string') return inner.sessionId;
    }
  }
  return null;
}
