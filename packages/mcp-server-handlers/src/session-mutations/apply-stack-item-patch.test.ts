import { describe, it, expect } from 'vitest';
import {
  ContractViolationError,
  type JsonObject,
  type PropsSpec,
  type StackItem,
} from '@ggui-ai/protocol';
import { applyStackItemPatch } from './apply-stack-item-patch.js';
import { StackItemNotFoundError } from './errors.js';

const PROPS_SPEC: PropsSpec = {
  properties: {
    city: { required: true, schema: { type: 'string' } },
  },
};

function makeItem(id: string, propsSpec?: PropsSpec): StackItem {
  return {
    id,
    componentCode: '/* stub */',
    createdAt: new Date().toISOString(),
    ...(propsSpec ? { propsSpec } : {}),
  };
}

describe('applyStackItemPatch', () => {
  it('updates the matching item and returns a new stack', () => {
    const stack: StackItem[] = [makeItem('page_a'), makeItem('page_b')];
    const { stack: next, updatedItem, updatedIndex } = applyStackItemPatch({
      stack,
      stackItemId: 'page_b',
      mode: 'merge' as const,
      patch: { city: 'Seoul' },
    });
    expect(updatedIndex).toBe(1);
    expect(updatedItem.id).toBe('page_b');
    expect(updatedItem.props).toEqual({ city: 'Seoul' });
    // original stack is not mutated
    expect(stack[1].props).toBeUndefined();
    expect(next).not.toBe(stack);
  });

  it('is a no-op on contract enforcement when the target has no propsSpec', () => {
    const stack: StackItem[] = [makeItem('page_a')];
    expect(() =>
      applyStackItemPatch({ stack, stackItemId: 'page_a', mode: 'merge' as const, patch: { anything: true } as JsonObject }),
    ).not.toThrow();
  });

  it('enforces the target item propsSpec — passes on valid patch', () => {
    const stack: StackItem[] = [makeItem('page_a', PROPS_SPEC)];
    expect(() =>
      applyStackItemPatch({ stack, stackItemId: 'page_a', mode: 'merge' as const, patch: { city: 'Seoul' } }),
    ).not.toThrow();
  });

  it('throws ContractViolationError{tool:ggui_update} on invalid patch', () => {
    const stack: StackItem[] = [makeItem('page_a', PROPS_SPEC)];
    let err: unknown;
    try {
      applyStackItemPatch({ stack, stackItemId: 'page_a', mode: 'merge' as const, patch: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContractViolationError);
    expect((err as ContractViolationError).tool).toBe('ggui_update');
  });

  it('throws StackItemNotFoundError when no stack item matches stackItemId', () => {
    const stack: StackItem[] = [makeItem('page_a'), makeItem('page_b')];
    expect(() =>
      applyStackItemPatch({ stack, stackItemId: 'page_missing', mode: 'merge' as const, patch: { city: 'x' } }),
    ).toThrow(StackItemNotFoundError);
  });

  it('StackItemNotFoundError message lists declared page ids', () => {
    const stack: StackItem[] = [makeItem('page_a'), makeItem('page_b')];
    try {
      applyStackItemPatch({ stack, stackItemId: 'page_missing', mode: 'merge' as const, patch: {} });
    } catch (e) {
      if (e instanceof StackItemNotFoundError) {
        expect(e.message).toContain('page_a');
        expect(e.message).toContain('page_b');
        expect(e.message).toContain('page_missing');
      } else {
        throw e;
      }
    }
  });

  it('accepts a minimal-shape stack (hosted DDB-row case)', () => {
    // Hosted passes Record-ish rows that satisfy StackItemTarget structurally.
    const stack = [
      { id: 'p1', extra: 'field' },
      { id: 'p2', propsSpec: PROPS_SPEC },
    ];
    const { updatedItem } = applyStackItemPatch({
      stack,
      stackItemId: 'p2',
      mode: 'merge' as const,
      patch: { city: 'Tokyo' },
    });
    expect(updatedItem.id).toBe('p2');
    // other fields flow through
    expect((updatedItem as { extra?: string }).extra).toBeUndefined(); // p2 didn't have one
  });
});
