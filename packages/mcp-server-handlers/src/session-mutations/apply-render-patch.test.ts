import { describe, it, expect } from 'vitest';
import {
  ContractViolationError,
  type JsonObject,
  type PropsSpec,
} from '@ggui-ai/protocol';
import {
  applyRenderPatch,
  type RenderTarget,
} from './apply-render-patch.js';

const PROPS_SPEC: PropsSpec = {
  properties: {
    city: { required: true, schema: { type: 'string' } },
  },
};

function makeRender(id: string, propsSpec?: PropsSpec): RenderTarget {
  return {
    id,
    ...(propsSpec ? { propsSpec } : {}),
  };
}

describe('applyRenderPatch', () => {
  it('updates the render and returns a new snapshot (immutable input)', () => {
    const render = makeRender('render_b');
    const { updatedRender, finalProps } = applyRenderPatch({
      render,
      mode: 'merge' as const,
      patch: { city: 'Seoul' },
    });
    expect(updatedRender.id).toBe('render_b');
    expect(updatedRender.props).toEqual({ city: 'Seoul' });
    expect(finalProps).toEqual({ city: 'Seoul' });
    // original input is not mutated
    expect(render.props).toBeUndefined();
  });

  it('is a no-op on contract enforcement when the render has no propsSpec', () => {
    const render = makeRender('render_a');
    expect(() =>
      applyRenderPatch({
        render,
        mode: 'merge' as const,
        patch: { anything: true } as JsonObject,
      }),
    ).not.toThrow();
  });

  it('enforces the render propsSpec — passes on valid patch', () => {
    const render = makeRender('render_a', PROPS_SPEC);
    expect(() =>
      applyRenderPatch({
        render,
        mode: 'merge' as const,
        patch: { city: 'Seoul' },
      }),
    ).not.toThrow();
  });

  it('throws ContractViolationError{tool:ggui_update} on invalid patch', () => {
    const render = makeRender('render_a', PROPS_SPEC);
    let err: unknown;
    try {
      applyRenderPatch({
        render,
        mode: 'merge' as const,
        patch: {},
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContractViolationError);
    expect((err as ContractViolationError).tool).toBe('ggui_update');
  });

  it('accepts a minimal-shape render (hosted DDB-row case)', () => {
    const render = { id: 'r1', extra: 'field' };
    const { updatedRender } = applyRenderPatch({
      render,
      mode: 'merge' as const,
      patch: { city: 'Tokyo' },
    });
    expect(updatedRender.id).toBe('r1');
    // extra field flows through
    expect((updatedRender as { extra?: string }).extra).toBe('field');
    expect(updatedRender.props).toEqual({ city: 'Tokyo' });
  });

  it('replace mode replaces the entire props map', () => {
    const render: RenderTarget & { props: JsonObject } = {
      id: 'r1',
      props: { city: 'Seoul', count: 1 },
    };
    const { updatedRender, finalProps } = applyRenderPatch({
      render,
      mode: 'replace' as const,
      props: { city: 'Tokyo' },
    });
    expect(updatedRender.props).toEqual({ city: 'Tokyo' });
    expect(finalProps).toEqual({ city: 'Tokyo' });
  });
});
