import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  RENDERING_DEVICES,
  RENDERING_SHELLS,
  renderingContextSchema,
  type RenderingContext,
} from './rendering-context';

// ggui#1000 (`items[].rendering?`) — the ONE rendering-context vocabulary.
// It existed twice as hand-declared unions (mcp-server-core `UiGenerateInput.rendering`,
// ui-gen `RenderingContext`) and nowhere as a schema; the bootstrap door needs to
// validate it on a wire, so it lives here and every consumer derives from it.
describe('renderingContextSchema (ggui#1000)', () => {
  it('names the full existing vocabulary — every shell × device, viewport optional', () => {
    expect(RENDERING_SHELLS).toEqual(['chat', 'fullscreen', 'partial']);
    expect(RENDERING_DEVICES).toEqual(['mobile', 'tablet', 'desktop', 'spatial']);
    for (const shell of RENDERING_SHELLS) {
      for (const device of RENDERING_DEVICES) {
        expect(renderingContextSchema.safeParse({ shell, device }).success).toBe(true);
      }
    }
    const full: RenderingContext = { shell: 'fullscreen', device: 'desktop', viewport: { width: 1440, height: 900 } };
    expect(renderingContextSchema.parse(full)).toEqual(full);
  });

  it('refuses a value outside the vocabulary, a missing member, an unknown key, and a degenerate viewport', () => {
    expect(renderingContextSchema.safeParse({ shell: 'widget', device: 'desktop' }).success).toBe(false);
    expect(renderingContextSchema.safeParse({ shell: 'chat', device: 'watch' }).success).toBe(false);
    expect(renderingContextSchema.safeParse({ shell: 'chat' }).success).toBe(false);
    expect(renderingContextSchema.safeParse({ shell: 'chat', device: 'mobile', theme: 'dark' }).success).toBe(false);
    expect(renderingContextSchema.safeParse({ shell: 'chat', device: 'mobile', viewport: { width: 0, height: 10 } }).success).toBe(false);
    expect(renderingContextSchema.safeParse({ shell: 'chat', device: 'mobile', viewport: { width: 10 } }).success).toBe(false);
    expect(renderingContextSchema.safeParse({ shell: 'chat', device: 'mobile', viewport: { width: 'wide', height: 1 } }).success).toBe(false);
  });

  it('is representable as JSON Schema (it ships through the route and the docs)', () => {
    const js = z.toJSONSchema(renderingContextSchema) as { properties?: Record<string, { enum?: string[] }> };
    expect(js.properties?.['shell']?.enum).toEqual(['chat', 'fullscreen', 'partial']);
    expect(js.properties?.['device']?.enum).toEqual(['mobile', 'tablet', 'desktop', 'spatial']);
  });
});
