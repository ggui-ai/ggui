/**
 * Parse→options boot-glue carry-through for the per-app theme overlay
 * (St3 M2.2).
 *
 * The renderer-side injection (`renderTree` → `:root` declaration block)
 * is covered in `react-renderer.test.ts` by setting `appTheme` DIRECTLY
 * on the mount options. THIS spec locks the OTHER half of the seam: that
 * a `theme` present on the wire `_meta["ai.ggui/render"]` slice SURVIVES
 * the iframe-runtime's own `validateMeta` → `projectMeta` re-projection,
 * since that re-projection is exactly where `theme` was being silently
 * stripped before this work. `buildOpts` (runtime.ts, a closure local to
 * `bootSequence`) reads `meta.theme` straight off this `validateMeta`
 * output and copies it onto `RenderItemOptions.appTheme` — so proving the
 * carry-through at `validateMeta` proves the full parse→options path up
 * to that 1:1 spread.
 */
import { describe, it, expect } from 'vitest';
import type { AppTheme } from '@ggui-ai/protocol';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { validateMeta } from '../meta-parse.js';

const baseSlice: McpAppAiGguiRenderMeta = {
  sessionId: 'sess-1',
  appId: 'app-1',
  runtimeUrl: 'https://runtime.example/bundle.js',
  appCallableTools: [],
  // static-component mode discriminator so `validateMeta` accepts the
  // slice without live-channel creds.
  codeUrl: 'https://code.example/component.js',
};

describe('validateMeta — per-app theme carry-through (St3 M2.2)', () => {
  it('carries a valid theme overlay through projectMeta onto the validated slice', () => {
    const theme: AppTheme = {
      mode: 'dark',
      cssVariables: { '--ggui-color-primary-600': '#7c3aed' },
    };

    const result = validateMeta({ ...baseSlice, theme });

    expect(result.ok).toBe(true);
    // Narrow the discriminated result without a cast.
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    // This is the exact value `buildOpts` copies onto
    // `RenderItemOptions.appTheme` (1:1 spread). Equality proves the
    // overlay was neither dropped nor mutated by the re-projection.
    expect(result.meta.theme).toEqual(theme);
  });

  it('omits theme when the slice has none', () => {
    const result = validateMeta(baseSlice);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.meta.theme).toBeUndefined();
  });
});
