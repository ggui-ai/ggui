/**
 * `validateMeta` — freeze-latch self-epoch carry-through (#483).
 *
 * The defensive field-by-field projection in `meta-parse.ts` is a
 * CONSUMER of every slice field: a field it does not copy is silently
 * dropped from the validated meta. `epoch` was exactly such a drop
 * (probe 18 round 2, 2026-08-13): the server emitted `epoch: 1` on the
 * update result envelope, the projection lost it, every mount booted
 * believing it was epoch 0, and the head card froze on its OWN amend's
 * epoch-1 frame. These pins make that class of drop a test failure.
 */
import { describe, it, expect } from 'vitest';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { validateMeta } from '../meta-parse.js';

const baseSlice: McpAppAiGguiRenderMeta = {
  sessionId: 'sess-1',
  appId: 'app-1',
  runtimeUrl: 'https://runtime.example/bundle.js',
  // static-component mode discriminator so `validateMeta` accepts the
  // slice without live-channel creds.
  codeUrl: 'https://code.example/component.js',
};

describe('validateMeta — self-epoch carry-through (#483)', () => {
  it('carries a numeric epoch through the projection', () => {
    const result = validateMeta({ ...baseSlice, epoch: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    // This is the value the boot reads as `selfEpoch` — the freeze
    // latch compares every live frame's epoch against it.
    expect(result.meta.epoch).toBe(3);
  });

  it('carries epoch 0 (a fresh render) — falsy but present', () => {
    const result = validateMeta({ ...baseSlice, epoch: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.meta.epoch).toBe(0);
  });

  it('omits epoch when the slice has none (pre-#483 producer)', () => {
    const result = validateMeta(baseSlice);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.meta.epoch).toBeUndefined();
  });

  it('collapses a non-number epoch to undefined (defensive)', () => {
    const result = validateMeta({
      ...baseSlice,
      epoch: '2',
    } as unknown as McpAppAiGguiRenderMeta);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.meta.epoch).toBeUndefined();
  });
});
