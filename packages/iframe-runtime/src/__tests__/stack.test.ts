/**
 * Unit tests for `StackModel` — exercises both the legacy multi-item
 * mode and the Phase 3 Wave 1 §S3 `filterToItemId` single-item mode.
 *
 * Integration-level coverage of the runtime → bootstrap →
 * StackModel(filterToItemId) wire is in `boot.test.ts`; this file
 * covers the model in isolation.
 */
import { describe, it, expect } from 'vitest';
import type { SessionStackEntry } from '@ggui-ai/protocol';
import { StackModel } from '../stack.js';

function makeItem(id: string, description?: string): SessionStackEntry {
  // Generated (component) variant — the `componentCode` field satisfies
  // the discriminator-free shape `StackModel` relies on. Keeping the
  // fixture deliberately minimal — the model only reads `.id`.
  return {
    id,
    type: 'component',
    componentCode: 'export default () => null;',
    ...(description !== undefined ? { description } : {}),
  } as SessionStackEntry;
}

describe('StackModel — multi-item (legacy) mode', () => {
  it('setAll stores the full incoming stack', () => {
    const m = new StackModel();
    m.setAll([makeItem('a'), makeItem('b'), makeItem('c')]);
    expect(m.snapshot().map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(m.size()).toBe(3);
  });

  it('upsert appends new items at the tail', () => {
    const m = new StackModel();
    m.setAll([makeItem('a')]);
    m.upsert(makeItem('b'));
    expect(m.snapshot().map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('upsert replaces existing items in place (preserves position)', () => {
    const m = new StackModel();
    m.setAll([makeItem('a'), makeItem('b'), makeItem('c')]);
    m.upsert(makeItem('b', 'updated'));
    expect(m.snapshot().map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(m.snapshot()[1]!.description).toBe('updated');
  });
});

describe('StackModel — filterToItemId (single-item mode)', () => {
  it('setAll retains only the entry matching filterToItemId', () => {
    const m = new StackModel({ filterToItemId: 'b' });
    m.setAll([makeItem('a'), makeItem('b'), makeItem('c')]);
    expect(m.snapshot().map((i) => i.id)).toEqual(['b']);
    expect(m.size()).toBe(1);
  });

  it('setAll yields an empty model when no entry matches', () => {
    const m = new StackModel({ filterToItemId: 'ghost' });
    m.setAll([makeItem('a'), makeItem('b')]);
    expect(m.snapshot()).toEqual([]);
    expect(m.size()).toBe(0);
  });

  it('setAll on an empty incoming stack keeps the model empty', () => {
    const m = new StackModel({ filterToItemId: 'a' });
    m.setAll([]);
    expect(m.snapshot()).toEqual([]);
  });

  it('upsert for the pinned id appends on first call', () => {
    const m = new StackModel({ filterToItemId: 'pinned' });
    m.upsert(makeItem('pinned'));
    expect(m.snapshot().map((i) => i.id)).toEqual(['pinned']);
  });

  it('upsert for the pinned id replaces in place on subsequent calls', () => {
    const m = new StackModel({ filterToItemId: 'pinned' });
    m.upsert(makeItem('pinned', 'v1'));
    m.upsert(makeItem('pinned', 'v2'));
    expect(m.snapshot()).toHaveLength(1);
    expect(m.snapshot()[0]!.description).toBe('v2');
  });

  it('upsert for non-matching ids is a no-op (session-scoped subscribe still delivers siblings)', () => {
    const m = new StackModel({ filterToItemId: 'pinned' });
    m.upsert(makeItem('pinned'));
    m.upsert(makeItem('sibling'));
    m.upsert(makeItem('other'));
    expect(m.snapshot().map((i) => i.id)).toEqual(['pinned']);
  });

  it('setAll followed by upsert to a non-matching id leaves the filtered item intact', () => {
    const m = new StackModel({ filterToItemId: 'b' });
    m.setAll([makeItem('a'), makeItem('b'), makeItem('c')]);
    m.upsert(makeItem('z', 'ignored'));
    expect(m.snapshot().map((i) => i.id)).toEqual(['b']);
  });

  it('filter is immutable — two independent models with different filters do not interfere', () => {
    const m1 = new StackModel({ filterToItemId: 'a' });
    const m2 = new StackModel({ filterToItemId: 'b' });
    m1.setAll([makeItem('a'), makeItem('b')]);
    m2.setAll([makeItem('a'), makeItem('b')]);
    expect(m1.snapshot().map((i) => i.id)).toEqual(['a']);
    expect(m2.snapshot().map((i) => i.id)).toEqual(['b']);
  });

  it('empty filterToItemId string pins to id === "" (not treated as absent)', () => {
    // Defensive contract: `filterToItemId: ''` means "pin to the empty id"
    // not "disable the filter." The current constructor uses `!== undefined`
    // for the activation check, so an explicit empty string stays active.
    const m = new StackModel({ filterToItemId: '' });
    m.setAll([makeItem('a'), makeItem('')]);
    expect(m.snapshot().map((i) => i.id)).toEqual(['']);
  });
});
