/**
 * ggui#1380 — ONE runtime-probe status union. `GenerationRuntimeProbeStatus`
 * is declared in `@ggui-ai/mcp-server-core` (a generation's metadata reports
 * it; core cannot import the engine) and `@ggui-ai/ui-gen`'s
 * `RuntimeProbeStatus` is that union under the engine's name — never a
 * parallel declaration that could drift by one arm. Type-level: a value of
 * either type is a value of the other, and the two are the same type.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GenerationRuntimeProbeStatus } from '@ggui-ai/mcp-server-core';
import type { RuntimeProbeStatus } from './types-public.js';

describe('RuntimeProbeStatus is GenerationRuntimeProbeStatus (ggui#1380)', () => {
  it('the engine name and the metadata name are one union', () => {
    const s: RuntimeProbeStatus = 'ran' satisfies GenerationRuntimeProbeStatus;
    const back: GenerationRuntimeProbeStatus = s;
    expectTypeOf<RuntimeProbeStatus>().toEqualTypeOf<GenerationRuntimeProbeStatus>();
    expectTypeOf<GenerationRuntimeProbeStatus>().toEqualTypeOf<'ran' | 'infra-skipped' | 'not-applicable' | 'timed-out'>();
    expect(back).toBe('ran');
  });
});
