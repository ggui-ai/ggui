import type { ContentBlock } from '@ggui-ai/protocol';

/**
 * Pull a durable GguiSession-shaped object out of a `tool_result` block's
 * `content` payload. Tolerant of shapes:
 *   - Direct: { id, componentCode, props, ... }                (GguiSession itself)
 *   - Wrapped: { render: {...} }
 *   - Nested: { result: { render: {...} } }
 *   - Nested direct: { result: { id, componentCode, ... } }
 *
 * Returns `null` if no GguiSession can be found — caller falls back to
 * placeholder rendering.
 *
 * Post-Phase-B: the legacy `stackItem` wrapper is gone — every tool
 * result carries a single flat `sessionId`. This stays a tolerant
 * heuristic over the remaining shapes (the `render` wrapper key plus
 * the direct GguiSession object) rather than pinning one producer's
 * envelope.
 */
export function extractRenderFromToolResult(block: ContentBlock): unknown | null {
  if (block.type !== 'tool_result') return null;
  const content = block.content as unknown;
  if (typeof content !== 'object' || content === null) return null;
  const rec = content as Record<string, unknown>;
  if (rec.render && typeof rec.render === 'object') return rec.render;
  if (typeof rec.id === 'string' && typeof rec.componentCode === 'string') return rec;
  for (const v of Object.values(rec)) {
    if (typeof v === 'object' && v !== null) {
      const inner = v as Record<string, unknown>;
      if (inner.render && typeof inner.render === 'object') return inner.render;
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
