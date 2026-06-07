import { describe, it, expect } from 'vitest';
import {
  ContractViolationError,
  type JsonObject,
  type PropsSpec,
} from '@ggui-ai/protocol';
import {
  applyGguiSessionPatch,
  type GguiSessionTarget,
} from './apply-ggui-session-patch.js';

const PROPS_SPEC: PropsSpec = {
  properties: {
    city: { required: true, schema: { type: 'string' } },
  },
};

function makeRender(id: string, propsSpec?: PropsSpec): GguiSessionTarget {
  return {
    id,
    ...(propsSpec ? { propsSpec } : {}),
  };
}

describe('applyGguiSessionPatch', () => {
  it('updates the render and returns a new snapshot (immutable input)', () => {
    const render = makeRender('render_b');
    const { updatedSession, finalProps } = applyGguiSessionPatch({
      render,
      mode: 'merge' as const,
      patch: { city: 'Seoul' },
    });
    expect(updatedSession.id).toBe('render_b');
    expect(updatedSession.props).toEqual({ city: 'Seoul' });
    expect(finalProps).toEqual({ city: 'Seoul' });
    // original input is not mutated
    expect(render.props).toBeUndefined();
  });

  it('is a no-op on contract enforcement when the render has no propsSpec', () => {
    const render = makeRender('render_a');
    expect(() =>
      applyGguiSessionPatch({
        render,
        mode: 'merge' as const,
        patch: { anything: true } as JsonObject,
      }),
    ).not.toThrow();
  });

  it('enforces the render propsSpec — passes on valid patch', () => {
    const render = makeRender('render_a', PROPS_SPEC);
    expect(() =>
      applyGguiSessionPatch({
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
      applyGguiSessionPatch({
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
    const render: GguiSessionTarget & { extra: string } = {
      id: 'r1',
      extra: 'field',
    };
    const { updatedSession } = applyGguiSessionPatch({
      render,
      mode: 'merge' as const,
      patch: { city: 'Tokyo' },
    });
    expect(updatedSession.id).toBe('r1');
    // extra field flows through (preserved via generic T)
    expect(updatedSession.extra).toBe('field');
    expect(updatedSession.props).toEqual({ city: 'Tokyo' });
  });

  it('replace mode replaces the entire props map', () => {
    const render: GguiSessionTarget & { props: JsonObject } = {
      id: 'r1',
      props: { city: 'Seoul', count: 1 },
    };
    const { updatedSession, finalProps } = applyGguiSessionPatch({
      render,
      mode: 'replace' as const,
      props: { city: 'Tokyo' },
    });
    expect(updatedSession.props).toEqual({ city: 'Tokyo' });
    expect(finalProps).toEqual({ city: 'Tokyo' });
  });
});
