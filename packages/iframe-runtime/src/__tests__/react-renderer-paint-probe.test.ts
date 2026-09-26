/**
 * Pin (ggui#1104): a mount that HOLDS a component and still paints nothing is
 * never silent.
 *
 * ggui#1103 named the two blanks where the renderer holds no component
 * (`no-code`, `eval-failed`). The served blank ir filmed (1 of 22 takes on a
 * fixed, bound hello cell: the scope div present at height 0, the tree never
 * painted, the error boundary never engaged, no console line) is the other
 * kind: the renderer had a component and the screen still stayed empty. A
 * probe that runs after every commit now names that kind too, by what the
 * committed DOM shows:
 *
 *   - `rendered-nothing`: the tree committed and the scope holds only its
 *     stylesheet (the component rendered no element);
 *   - `detached`: the tree committed into a scope that is no longer in the
 *     document (a second mount replaced the container);
 *   - `no-commit`: the tree never committed at all within the deadline (for
 *     example a component that suspends with no Suspense boundary).
 *
 * Each reports on the console and on the host's observability seam
 * (`component-empty { where, reason }`), once per blank episode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import * as ReactDOM from 'react-dom';
import * as wire from '@ggui-ai/wire';
import { mountReactRoot, __setNoCommitDeadlineForTest } from '../react-renderer.js';
import { installGlobalRegistry } from '../globals.js';

interface PostedEvent {
  readonly kind?: string;
  readonly where?: string;
  readonly reason?: string;
}

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

async function flush(fn: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await fn();
  });
}

function captureObservability(): { readonly events: PostedEvent[]; restore: () => void } {
  const events: PostedEvent[] = [];
  const spy = vi.spyOn(window.parent, 'postMessage').mockImplementation((message: unknown) => {
    const event = (message as { event?: PostedEvent })?.event;
    if (event !== undefined) events.push(event);
  });
  return { events, restore: () => spy.mockRestore() };
}

const empties = (events: readonly PostedEvent[]) => events.filter((e) => e.kind === 'component-empty');

/** A component that paints its heading unless told to render nothing. */
const CARD = `import React from 'react';
export default function Card(props) {
  if (props.hide) return null;
  return React.createElement('h1', null, props.title ?? 'Hello');
}`;
const NULL_CARD = 'export default function Card() { return null; }';

describe('a mount that holds a component and paints nothing is named (ggui#1104)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let seam: ReturnType<typeof captureObservability>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    seam = captureObservability();
    const empty: Record<string, never> = {};
    installGlobalRegistry({ react: React, reactDom: ReactDOM, primitives: empty, components: empty, compositions: empty, interact: empty, tokens: empty, wire });
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    seam.restore();
    __setNoCommitDeadlineForTest(null);
  });

  it('a component that renders no element: a console line + component-empty { mount, rendered-nothing }', async () => {
    const container = makeContainer();
    await flush(() => mountReactRoot(container, { render: { componentCode: NULL_CARD, props: {} } }));
    expect(empties(seam.events)).toEqual([{ kind: 'component-empty', where: 'mount', reason: 'rendered-nothing' }]);
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('(rendered-nothing)');
  });

  it('a component that paints is not reported', async () => {
    const container = makeContainer();
    await flush(() => mountReactRoot(container, { render: { componentCode: CARD, props: {} } }));
    expect(container.querySelector('h1')?.textContent).toBe('Hello');
    expect(empties(seam.events)).toEqual([]);
  });

  it('an update that empties the tree is reported once per blank episode, and again after the tree paints and empties again', async () => {
    const container = makeContainer();
    const mount = { current: null as Awaited<ReturnType<typeof mountReactRoot>> | null };
    await flush(async () => {
      mount.current = await mountReactRoot(container, { render: { componentCode: CARD, props: {} } });
    });
    await flush(() => mount.current!.update({ render: { componentCode: CARD, props: { hide: true } } }));
    await flush(() => mount.current!.update({ render: { componentCode: CARD, props: { hide: true, title: 'x' } } }));
    expect(empties(seam.events)).toEqual([{ kind: 'component-empty', where: 'update', reason: 'rendered-nothing' }]);
    await flush(() => mount.current!.update({ render: { componentCode: CARD, props: {} } }));
    await flush(() => mount.current!.update({ render: { componentCode: CARD, props: { hide: true } } }));
    expect(empties(seam.events)).toHaveLength(2);
  });

  it('a tree that commits into a scope no longer in the document: component-empty { update, detached }', async () => {
    const container = makeContainer();
    const first = { current: null as Awaited<ReturnType<typeof mountReactRoot>> | null };
    await flush(async () => {
      first.current = await mountReactRoot(container, { render: { componentCode: CARD, props: {} } });
    });
    // A second mount takes the same container over and removes the first tree's DOM.
    await flush(() => mountReactRoot(container, { render: { componentCode: CARD, props: { title: 'second' } } }));
    await flush(() => first.current!.update({ render: { componentCode: CARD, props: { title: 'stale' } } }));
    expect(empties(seam.events)).toContainEqual({ kind: 'component-empty', where: 'update', reason: 'detached' });
  });

  it('a tree that never commits (a component suspending with no boundary): component-empty { mount, no-commit } after the deadline', async () => {
    __setNoCommitDeadlineForTest(50);
    const container = makeContainer();
    const SUSPENDS = 'const never = new Promise(() => {}); export default function Card() { throw never; }';
    await flush(() => mountReactRoot(container, { render: { componentCode: SUSPENDS, props: {} } }));
    await new Promise((r) => setTimeout(r, 120));
    expect(empties(seam.events)).toContainEqual({ kind: 'component-empty', where: 'mount', reason: 'no-commit' });
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('(no-commit)');
  });

  it('a component that commits in time never reports no-commit', async () => {
    __setNoCommitDeadlineForTest(50);
    const container = makeContainer();
    await flush(() => mountReactRoot(container, { render: { componentCode: CARD, props: {} } }));
    await new Promise((r) => setTimeout(r, 120));
    expect(empties(seam.events)).toEqual([]);
  });
});
