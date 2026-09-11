import type { RenderingContext as ProtocolRenderingContext } from '@ggui-ai/protocol';
import { describe, expectTypeOf, it } from 'vitest';
import type { RenderingContext } from './contract-context.js';

// ggui#1000 — ui-gen's RenderingContext IS the protocol's (derived, not re-declared).
describe('RenderingContext derives from @ggui-ai/protocol (ggui#1000)', () => {
  it('is the same type in both directions', () => {
    expectTypeOf<RenderingContext>().toEqualTypeOf<ProtocolRenderingContext>();
    expectTypeOf<ProtocolRenderingContext>().toEqualTypeOf<RenderingContext>();
  });
});
