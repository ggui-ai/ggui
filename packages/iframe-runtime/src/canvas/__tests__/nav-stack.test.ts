/**
 * NavStackModel tests.
 *
 * Pure-model coverage: push / pop / peek / reset semantics, in-place
 * replacement on duplicate id, version counter monotonicity, the
 * onMutation vs onNavChange listener split.
 */
import { describe, expect, it, vi } from 'vitest';
import { NavStackModel, type NavStackChangeListener } from '../nav-stack.js';
import type { SessionStackEntry } from '@ggui-ai/protocol';

function item(id: string): SessionStackEntry {
  return {
    id,
    type: 'component',
    componentCode: '',
    description: `item ${id}`,
  } as SessionStackEntry;
}

describe('NavStackModel', () => {
  it('starts empty', () => {
    const m = new NavStackModel();
    expect(m.size()).toBe(0);
    expect(m.peek()).toBeNull();
    expect(m.snapshot()).toEqual([]);
    expect(m.version()).toBe(0);
  });

  it('push appends and bumps version', () => {
    const m = new NavStackModel();
    m.push(item('a'));
    expect(m.size()).toBe(1);
    expect(m.peek()?.id).toBe('a');
    expect(m.version()).toBe(1);
    m.push(item('b'));
    expect(m.peek()?.id).toBe('b');
    expect(m.snapshot().map((i) => i.id)).toEqual(['a', 'b']);
    expect(m.version()).toBe(2);
  });

  it('push of duplicate id replaces IN PLACE (preserves nav position)', () => {
    const m = new NavStackModel();
    m.push(item('a'));
    m.push(item('b'));
    m.push(item('c'));
    const versionBefore = m.version();
    // Update b (props changed via ggui_update). Should replace b's
    // entry at index 1 — not move to top, not duplicate.
    const updatedB: SessionStackEntry = {
      id: 'b',
      type: 'component',
      componentCode: '',
      description: 'updated',
    } as SessionStackEntry;
    m.push(updatedB);
    expect(m.snapshot().map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(m.snapshot()[1].description).toBe('updated');
    expect(m.peek()?.id).toBe('c'); // c still on top
    expect(m.version()).toBe(versionBefore + 1); // version still bumps
  });

  it('pop returns the new active item (post-pop)', () => {
    const m = new NavStackModel();
    m.push(item('a'));
    m.push(item('b'));
    const active = m.pop();
    expect(active?.id).toBe('a');
    expect(m.size()).toBe(1);
  });

  it('pop on empty stack is a no-op', () => {
    const m = new NavStackModel();
    expect(m.pop()).toBeNull();
    expect(m.size()).toBe(0);
    expect(m.version()).toBe(0);
  });

  it('reset replaces the entire stack', () => {
    const m = new NavStackModel();
    m.push(item('a'));
    m.push(item('b'));
    m.reset([item('x'), item('y'), item('z')]);
    expect(m.snapshot().map((i) => i.id)).toEqual(['x', 'y', 'z']);
    expect(m.peek()?.id).toBe('z');
  });

  describe('onNavChange listener', () => {
    it('fires on push with direction=forward', () => {
      const m = new NavStackModel();
      const listener: NavStackChangeListener = vi.fn();
      m.onNavChange(listener);
      m.push(item('a'));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenLastCalledWith({
        direction: 'forward',
        activeItemId: 'a',
        previousActiveItemId: null,
      });
      m.push(item('b'));
      expect(listener).toHaveBeenLastCalledWith({
        direction: 'forward',
        activeItemId: 'b',
        previousActiveItemId: 'a',
      });
    });

    it('does NOT fire on in-place replace (active item unchanged)', () => {
      const m = new NavStackModel();
      const listener = vi.fn();
      m.push(item('a'));
      m.onNavChange(listener); // subscribe AFTER initial push
      m.push(item('a')); // same id → in-place replace
      expect(listener).not.toHaveBeenCalled();
    });

    it('fires on pop with direction=back', () => {
      const m = new NavStackModel();
      m.push(item('a'));
      m.push(item('b'));
      const listener = vi.fn();
      m.onNavChange(listener);
      m.pop();
      expect(listener).toHaveBeenCalledWith({
        direction: 'back',
        activeItemId: 'a',
        previousActiveItemId: 'b',
      });
    });

    it('pop to empty surfaces activeItemId=null', () => {
      const m = new NavStackModel();
      m.push(item('a'));
      const listener = vi.fn();
      m.onNavChange(listener);
      m.pop();
      expect(listener).toHaveBeenCalledWith({
        direction: 'back',
        activeItemId: null,
        previousActiveItemId: 'a',
      });
    });

    it('unsubscribe removes the listener', () => {
      const m = new NavStackModel();
      const listener = vi.fn();
      const unsub = m.onNavChange(listener);
      m.push(item('a'));
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
      m.push(item('b'));
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });
  });

  describe('onMutation listener', () => {
    it('fires on every state mutation INCLUDING in-place replace', () => {
      const m = new NavStackModel();
      const listener = vi.fn();
      m.onMutation(listener);
      m.push(item('a'));
      expect(listener).toHaveBeenCalledTimes(1);
      m.push(item('b'));
      expect(listener).toHaveBeenCalledTimes(2);
      m.push(item('b')); // in-place replace — onNavChange skips, onMutation fires
      expect(listener).toHaveBeenCalledTimes(3);
      m.pop();
      expect(listener).toHaveBeenCalledTimes(4);
      m.reset([item('z')]);
      expect(listener).toHaveBeenCalledTimes(5);
    });

    it('in-place replace fires onMutation but NOT onNavChange', () => {
      // This is the bug we were fixing: ggui_update bumps version but
      // the canvas shell wasn't re-rendering because the old single
      // listener suppressed in-place replaces. The two-listener split
      // separates "React needs to re-render" from "tell server about
      // navigation".
      const m = new NavStackModel();
      m.push(item('a'));
      const mutation = vi.fn();
      const navChange = vi.fn();
      m.onMutation(mutation);
      m.onNavChange(navChange);
      m.push(item('a')); // in-place replace
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(navChange).not.toHaveBeenCalled();
    });

    it('unsubscribe removes the listener', () => {
      const m = new NavStackModel();
      const listener = vi.fn();
      const unsub = m.onMutation(listener);
      m.push(item('a'));
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
      m.push(item('b'));
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  it('version counter monotonically increases on every mutation', () => {
    const m = new NavStackModel();
    expect(m.version()).toBe(0);
    m.push(item('a'));
    m.push(item('b'));
    m.push(item('a')); // in-place replace still bumps
    m.pop();
    m.reset([item('x')]);
    expect(m.version()).toBe(5);
  });
});
