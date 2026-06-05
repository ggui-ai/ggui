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
 * Post-Phase-B: the wrapper key was `stackItem` pre-collapse; now it's
 * `render`. Stack item ID and session ID are gone — every render
 * carries a single flat `renderId`.
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

/** Same traversal looking for just a renderId field. */
export function extractRenderIdFromToolResult(block: ContentBlock): string | null {
  if (block.type !== 'tool_result') return null;
  const content = block.content as unknown;
  if (typeof content !== 'object' || content === null) return null;
  const rec = content as Record<string, unknown>;
  if (typeof rec.renderId === 'string') return rec.renderId;
  for (const v of Object.values(rec)) {
    if (typeof v === 'object' && v !== null) {
      const inner = v as Record<string, unknown>;
      if (typeof inner.renderId === 'string') return inner.renderId;
    }
  }
  return null;
}
