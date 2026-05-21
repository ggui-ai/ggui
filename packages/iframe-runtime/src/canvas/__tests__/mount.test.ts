/**
 * mountCanvas integration test.
 *
 * Pins:
 *   - mountCanvas returns navStack + events + contentEl + dispose
 *   - setStack flows through to NavStackModel.reset
 *   - pushItem flows through to NavStackModel.push (idempotent on dup)
 *   - dispose unmounts the React tree (subsequent setStack is a no-op
 *     against an unmounted root and MUST NOT throw)
 *
 * Uses jsdom + real react + react-dom/client. The full
 * canvas-with-content render path is covered by the shell's own tests;
 * here we only test the wiring seam.
 */
import { describe, expect, it } from 'vitest';
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import type { SessionStackEntry } from '@ggui-ai/protocol';
import { mountCanvas } from '../mount.js';


function makeItem(id: string): SessionStackEntry {
  return {
    id,
    type: 'component',
    componentCode: '',
    description: `item ${id}`,
  } as SessionStackEntry;
}

describe('mountCanvas', () => {
  it('mounts a React tree into the host element + exposes a content slot', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountCanvas(host, {
      react: React,
      reactDomClient: ReactDOMClient,
    });
    expect(handle.contentEl).toBeInstanceOf(HTMLElement);
    expect(handle.contentEl.getAttribute('data-ggui-canvas-content-slot'))
      .toBe('true');
    handle.dispose();
    document.body.removeChild(host);
  });

  it('setStack feeds the NavStackModel (reset semantics)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountCanvas(host, {
      react: React,
      reactDomClient: ReactDOMClient,
    });
    handle.setStack([makeItem('a'), makeItem('b'), makeItem('c')]);
    expect(handle.navStack.size()).toBe(3);
    expect(handle.navStack.peek()?.id).toBe('c');
    handle.dispose();
    document.body.removeChild(host);
  });

  it('pushItem appends + in-place-replaces on duplicate id', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountCanvas(host, {
      react: React,
      reactDomClient: ReactDOMClient,
    });
    handle.pushItem(makeItem('a'));
    handle.pushItem(makeItem('b'));
    expect(handle.navStack.size()).toBe(2);
    // Duplicate id → in-place replace (no shift).
    const replaced: SessionStackEntry = {
      id: 'a',
      type: 'component',
      componentCode: '',
      description: 'replaced',
    } as SessionStackEntry;
    handle.pushItem(replaced);
    expect(handle.navStack.size()).toBe(2);
    expect(handle.navStack.snapshot()[0].description).toBe('replaced');
    expect(handle.navStack.peek()?.id).toBe('b');
    handle.dispose();
    document.body.removeChild(host);
  });

  it('publishLifecycle translates wire payload into the matching AnimatorEvent', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountCanvas(host, {
      react: React,
      reactDomClient: ReactDOMClient,
    });
    const received: Array<{ kind: string }> = [];
    handle.events.subscribe((e) => received.push(e));
    handle.events.publishLifecycle({
      kind: 'handshake_started',
      handshakeId: 'h-1',
      intent: 'show weather',
    });
    handle.events.publishLifecycle({
      kind: 'push_started',
      stackItemId: 'stk-1',
      intent: 'show weather',
    });
    handle.events.publishLifecycle({
      kind: 'consume_polling',
      state: 'open',
      stackItemId: 'stk-1',
    });
    expect(received.map((e) => e.kind)).toEqual([
      'handshake_started',
      'push_started',
      'consume_polling',
    ]);
    handle.dispose();
    document.body.removeChild(host);
  });

  it('events bus delivers published events to subscribers', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountCanvas(host, {
      react: React,
      reactDomClient: ReactDOMClient,
    });
    const received: unknown[] = [];
    const unsubscribe = handle.events.subscribe((e) => received.push(e));
    handle.events.publish({
      kind: 'handshake_started',
      payload: { kind: 'handshake_started', handshakeId: 'h-1', intent: 'Thinking' },
    });
    expect(received).toHaveLength(1);
    unsubscribe();
    handle.events.publish({
      kind: 'handshake_started',
      payload: { kind: 'handshake_started', handshakeId: 'h-2', intent: 'Thinking' },
    });
    expect(received).toHaveLength(1); // unsubscribed
    handle.dispose();
    document.body.removeChild(host);
  });

  it('dispose unmounts the React tree without throwing', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountCanvas(host, {
      react: React,
      reactDomClient: ReactDOMClient,
    });
    expect(() => handle.dispose()).not.toThrow();
    // Idempotent — calling twice MUST NOT throw (React's createRoot
    // rejects double-unmount; we catch it).
    expect(() => handle.dispose()).not.toThrow();
    document.body.removeChild(host);
  });

  it('registerCleanup callbacks fire on dispose in registration order', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountCanvas(host, {
      react: React,
      reactDomClient: ReactDOMClient,
    });
    const calls: string[] = [];
    handle.registerCleanup(() => calls.push('a'));
    handle.registerCleanup(() => {
      throw new Error('b throws');
    });
    handle.registerCleanup(() => calls.push('c'));
    handle.dispose();
    // 'a' and 'c' must fire even though 'b' throws.
    expect(calls).toEqual(['a', 'c']);
    // Idempotent — second dispose drains nothing (queue cleared).
    handle.dispose();
    expect(calls).toEqual(['a', 'c']);
    document.body.removeChild(host);
  });

  it('setDisplayMode + setAvailableDisplayModes update without remount', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = mountCanvas(host, {
      react: React,
      reactDomClient: ReactDOMClient,
    });
    expect(() => handle.setAvailableDisplayModes(['inline', 'fullscreen']))
      .not.toThrow();
    expect(() => handle.setDisplayMode('fullscreen')).not.toThrow();
    handle.dispose();
    document.body.removeChild(host);
  });
});
