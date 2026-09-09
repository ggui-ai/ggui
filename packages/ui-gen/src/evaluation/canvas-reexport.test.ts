import { describe, expect, it } from 'vitest';
import { CANVAS_CLASSES, CANVAS_VIEWPORTS, canvasForViewportWidth, describeCanvas } from './index.js';
import type { CanvasClass } from './index.js';

// Pin: the `@ggui-ai/ui-gen/evaluation` subpath carries the canvas
// vocabulary the per-canvas visual evaluation speaks, and it is the SAME
// vocabulary as the package root (one source, `design-mode.ts`).
describe('evaluation subpath — canvas vocabulary re-export', () => {
  it('exposes the five classes, their viewports and the mapping helpers', () => {
    expect(CANVAS_CLASSES).toEqual(['xs-chat-card', 'mobile-fullscreen-small', 'md', 'lg', 'xl']);
    for (const c of CANVAS_CLASSES) {
      const v = CANVAS_VIEWPORTS[c];
      expect(v.width).toBeGreaterThan(0);
      expect(v.height).toBeGreaterThan(0);
      expect(describeCanvas(c).length).toBeGreaterThan(0);
    }
    const md: CanvasClass = canvasForViewportWidth('fullscreen', 800);
    expect(md).toBe('md');
  });
});
