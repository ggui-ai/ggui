/**
 * context-observer tests.
 *
 * Coverage matrix:
 *   - `ensureContext` / `installContextRegistry`: idempotency on
 *     re-install, default-value seeding, displayName population.
 *   - `createSingleSlotProvider`: useState-owned value, debounced
 *     post, immediate-post when `debounceMs <= 0`, schema-validation
 *     drop, contextSlotLastValues side-effect tracking, Provider
 *     value shape (live `[value, setValue]` tuple).
 *   - `createContextStateHost`: composes one Provider per slot,
 *     children receive live tuples via the wire-package
 *     `useGguiContext` hook.
 *   - `reemitLastContextValues`: cross-contract leak filter.
 *
 * Post-Phase-1.19b.3 followup (#275): the snapshot poster split into
 * a {@link ContextSnapshotPoster} interface with `postUpdateModelContext`
 * (spec-canonical notification, production via
 * `app.updateModelContext`) and `postContextMirror` (server-mirror
 * `tools/call`, production raw postMessage). Tests build a recording
 * poster via {@link makeRecordingPoster} and assert on the captured
 * payloads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import * as React from 'react';
import {
  contextSlotLastValues,
  createContextStateHost,
  createSingleSlotProvider,
  ensureContext,
  installContextRegistry,
  reemitLastContextValues,
  type ContextSlotInfo,
  type ContextSnapshotPoster,
  type ResolvedContextSlot,
} from '../context-observer.js';
import type { GguiContextRegistry } from '../globals.js';

type UpdateModelContextParams = Parameters<
  ContextSnapshotPoster['postUpdateModelContext']
>[0];
type ContextMirrorParams = Parameters<
  ContextSnapshotPoster['postContextMirror']
>[0];

interface RecordingPoster {
  readonly poster: ContextSnapshotPoster;
  readonly updates: UpdateModelContextParams[];
  readonly mirrors: ContextMirrorParams[];
}

/**
 * Build a {@link ContextSnapshotPoster} that records every emission
 * into two parallel arrays — `updates` for the spec-canonical
 * `ui/update-model-context` notification and `mirrors` for the
 * `ggui_runtime_sync_context` server-mirror call. Tests that only
 * care about the update path read `updates`; the mirror path is
 * recorded for completeness even when no `identity` is passed (in
 * which case it stays empty).
 */
function makeRecordingPoster(): RecordingPoster {
  const updates: UpdateModelContextParams[] = [];
  const mirrors: ContextMirrorParams[] = [];
  return {
    updates,
    mirrors,
    poster: {
      postUpdateModelContext: (params) => {
        updates.push(params);
      },
      postContextMirror: (params) => {
        mirrors.push(params);
      },
    },
  };
}

beforeEach(() => {
  // Reset module-level state between tests so spec ordering is irrelevant.
  contextSlotLastValues.clear();
});

describe('ensureContext — idempotency', () => {
  it('creates a fresh React.Context when the contextName is absent', () => {
    const registry: GguiContextRegistry = {};
    const slot: ContextSlotInfo = {
      name: 'currentStep',
      contextName: 'CurrentStepContext',
      schema: { type: 'number' },
      default: 0,
    };
    const resolved = ensureContext(registry, React, slot);
    expect(registry['CurrentStepContext']).toBeDefined();
    expect(resolved.contextRef).toBe(registry['CurrentStepContext']);
    // displayName populated for devtools observability.
    expect(
      (resolved.contextRef as React.Context<unknown>).displayName,
    ).toBe('CurrentStepContext');
  });

  it('REUSES the existing Context on a second call (re-mount idempotency)', () => {
    const registry: GguiContextRegistry = {};
    const slot: ContextSlotInfo = {
      name: 'currentStep',
      contextName: 'CurrentStepContext',
      schema: { type: 'number' },
      default: 0,
    };
    const first = ensureContext(registry, React, slot);
    const second = ensureContext(registry, React, slot);
    expect(second.contextRef).toBe(first.contextRef);
  });

  it('applies the default debounceMs when entry omits one', () => {
    const registry: GguiContextRegistry = {};
    const resolved = ensureContext(registry, React, {
      name: 'a',
      contextName: 'AContext',
      schema: { type: 'string' },
      default: '',
    });
    expect(resolved.debounceMs).toBe(300);
  });

  it('honors per-slot debounceMs override', () => {
    const registry: GguiContextRegistry = {};
    const resolved = ensureContext(registry, React, {
      name: 'a',
      contextName: 'AContext',
      schema: { type: 'string' },
      default: '',
      debounceMs: 1000,
    });
    expect(resolved.debounceMs).toBe(1000);
  });
});

describe('installContextRegistry', () => {
  it('returns one resolved slot per input entry', () => {
    const registry: GguiContextRegistry = {};
    const slots: ContextSlotInfo[] = [
      {
        name: 'a',
        contextName: 'AContext',
        schema: { type: 'string' },
        default: '',
      },
      {
        name: 'b',
        contextName: 'BContext',
        schema: { type: 'number' },
        default: 0,
      },
    ];
    const resolved = installContextRegistry(registry, React, slots);
    expect(resolved).toHaveLength(2);
    expect(registry['AContext']).toBeDefined();
    expect(registry['BContext']).toBeDefined();
  });

  it('reuses entries on a second install (idempotency)', () => {
    const registry: GguiContextRegistry = {};
    const slots: ContextSlotInfo[] = [
      {
        name: 'a',
        contextName: 'AContext',
        schema: { type: 'string' },
        default: '',
      },
    ];
    const first = installContextRegistry(registry, React, slots);
    const second = installContextRegistry(registry, React, slots);
    expect(second[0]?.contextRef).toBe(first[0]?.contextRef);
  });
});

function buildResolved(
  slot: ContextSlotInfo,
  registry: GguiContextRegistry = {},
): ResolvedContextSlot {
  return ensureContext(registry, React, slot);
}

describe('createSingleSlotProvider — owns useState + posts on change', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('seeds Provider value with `slot.default` on first mount', () => {
    const { poster } = makeRecordingPoster();
    const SingleSlotProvider = createSingleSlotProvider({
      react: React,
      poster,
    });

    const slot = buildResolved({
      name: 'currentStep',
      contextName: 'CurrentStepContext',
      schema: { type: 'number' },
      default: 5,
      debounceMs: 0,
    });

    let observedTuple: readonly [unknown, unknown] | null = null;
    function ChildReader(): React.ReactElement | null {
      observedTuple = React.useContext(slot.contextRef);
      return null;
    }

    render(
      React.createElement(
        SingleSlotProvider,
        { slot },
        React.createElement(ChildReader, null),
      ),
    );

    expect(observedTuple).not.toBeNull();
    if (observedTuple) {
      expect(observedTuple[0]).toBe(5);
      expect(typeof observedTuple[1]).toBe('function');
    }
  });

  it('posts ui/update-model-context immediately when debounceMs is 0', () => {
    const recorder = makeRecordingPoster();
    const SingleSlotProvider = createSingleSlotProvider({
      react: React,
      poster: recorder.poster,
    });

    const slot = buildResolved({
      name: 'tabIndex',
      contextName: 'TabIndexContext',
      schema: { type: 'number' },
      default: 2,
      debounceMs: 0,
    });

    render(React.createElement(SingleSlotProvider, { slot }));
    expect(recorder.updates).toHaveLength(1);
    const text = recorder.updates[0]?.content?.[0]?.text ?? '';
    expect(text).toContain('tabIndex');
    expect(contextSlotLastValues.get('tabIndex')).toBe(2);
  });

  it('debounces value changes', () => {
    vi.useFakeTimers();
    const recorder = makeRecordingPoster();
    const SingleSlotProvider = createSingleSlotProvider({
      react: React,
      poster: recorder.poster,
    });

    const slot = buildResolved({
      name: 'currentStep',
      contextName: 'CurrentStepContext',
      schema: { type: 'number' },
      default: 0,
      debounceMs: 300,
    });

    render(React.createElement(SingleSlotProvider, { slot }));
    expect(recorder.updates).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(recorder.updates).toHaveLength(1);
  });

  it('drops + warns when value violates the slot schema', () => {
    const recorder = makeRecordingPoster();
    const warnings: unknown[][] = [];
    const SingleSlotProvider = createSingleSlotProvider({
      react: React,
      poster: recorder.poster,
      consoleWarn: (...args) => warnings.push(args),
    });

    const slot = buildResolved({
      name: 'currentStep',
      contextName: 'CurrentStepContext',
      schema: { type: 'number' },
      // Default deliberately violates schema to exercise the validator.
      default: 'not-a-number',
      debounceMs: 0,
    });

    render(React.createElement(SingleSlotProvider, { slot }));
    expect(recorder.updates).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    const firstArg = warnings[0]?.[0];
    expect(typeof firstArg).toBe('string');
    expect(firstArg as string).toContain("slot 'currentStep'");
  });

  it('exposes a live setter that updates the Provider value', () => {
    const recorder = makeRecordingPoster();
    const SingleSlotProvider = createSingleSlotProvider({
      react: React,
      poster: recorder.poster,
    });

    const slot = buildResolved({
      name: 'currentStep',
      contextName: 'CurrentStepContext',
      schema: { type: 'number' },
      default: 0,
      debounceMs: 0,
    });

    let capturedSetter: ((next: unknown) => void) | null = null;
    let observedValue: unknown = null;
    function Child(): React.ReactElement | null {
      const [value, setValue] = React.useContext(slot.contextRef);
      observedValue = value;
      capturedSetter = setValue;
      return null;
    }

    render(
      React.createElement(
        SingleSlotProvider,
        { slot },
        React.createElement(Child, null),
      ),
    );
    expect(observedValue).toBe(0);
    expect(typeof capturedSetter).toBe('function');

    act(() => {
      capturedSetter!(7);
    });
    expect(observedValue).toBe(7);
    // The post on the new value lands too (debounceMs=0).
    // Snapshot format: latest snapshot includes the new value under
    // the slot's name.
    const lastUpdate = recorder.updates[recorder.updates.length - 1];
    expect(lastUpdate?.content?.[0]?.text).toContain('"currentStep":7');
  });
});

describe('createContextStateHost — composes Providers around children', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders children unchanged when slots is empty', () => {
    const { poster } = makeRecordingPoster();
    const ContextStateHost = createContextStateHost({
      react: React,
      poster,
    });
    const { container } = render(
      React.createElement(ContextStateHost, {
        slots: [],
        children: React.createElement('span', { 'data-testid': 'child' }, 'hi'),
      }),
    );
    expect(container.textContent).toContain('hi');
  });

  it('wraps user component so useContext sees live tuples for every slot', () => {
    const recorder = makeRecordingPoster();
    const registry: GguiContextRegistry = {};
    const slots = [
      buildResolved(
        {
          name: 'currentStep',
          contextName: 'CurrentStepContext',
          schema: { type: 'number' },
          default: 1,
          debounceMs: 0,
        },
        registry,
      ),
      buildResolved(
        {
          name: 'draftText',
          contextName: 'DraftTextContext',
          schema: { type: 'string' },
          default: 'hello',
          debounceMs: 0,
        },
        registry,
      ),
    ];

    const ContextStateHost = createContextStateHost({
      react: React,
      poster: recorder.poster,
    });

    let observed: { step: unknown; draft: unknown } | null = null;
    function User(): React.ReactElement | null {
      const [step] = React.useContext(slots[0]!.contextRef);
      const [draft] = React.useContext(slots[1]!.contextRef);
      observed = { step, draft };
      return null;
    }

    render(
      React.createElement(ContextStateHost, {
        slots,
        children: React.createElement(User, null),
      }),
    );

    expect(observed).toEqual({ step: 1, draft: 'hello' });
    // Snapshot semantics. Each post carries the full current state;
    // assert both slot names appear in at least one snapshot text.
    const slotsPosted = recorder.updates.map((params) => params.content?.[0]?.text ?? '');
    expect(slotsPosted.some((t) => t.includes('"currentStep":1'))).toBe(true);
    expect(slotsPosted.some((t) => t.includes('"draftText":"hello"'))).toBe(
      true,
    );
    // Sanity — every post is tagged `[ggui:context]` (snapshot), not
    // the legacy `[ggui:context-slot]` per-slot delta tag.
    expect(slotsPosted.every((t) => t.startsWith('[ggui:context] '))).toBe(
      true,
    );
  });
});

// ── Regression test — the load-bearing one ─────────────────────────
//
// An earlier design had the runtime mount observers as SIBLINGS of
// the user component while the boilerplate emitted Providers INSIDE
// the user component. The observer's `useContext` therefore read the
// createContext default — never the user's setState-driven Provider
// value. Tests passed because they mocked around the broken seam.
//
// This test simulates the FULL fixed path:
//   1. Wire `useGguiContext` hook reads from `globalThis.__ggui__.contexts`.
//   2. Runtime composes ContextStateHost around the user component.
//   3. User component mutates state via the hook's setter.
//   4. SingleSlotProvider's effect posts on value change.
//
// If F1 ever regresses (Provider mounts as sibling again, or boilerplate
// resumes emitting useState inside the user component), this test
// catches it because the spy never sees the post.
describe('F1 regression — runtime hoisting actually flows setState to posts', () => {
  afterEach(() => {
    cleanup();
    // Clean up the synthesized global registry between cases.
    delete (globalThis as { __ggui__?: unknown }).__ggui__;
  });

  it('useGguiContext setter -> SingleSlotProvider post -> contextSlotLastValues', async () => {
    // 1) Synthesize the global registry the wire hook reads from.
    const registry: GguiContextRegistry = {};
    const slot = buildResolved(
      {
        name: 'foo',
        contextName: 'FooContext',
        schema: { type: 'number' },
        default: 0,
        debounceMs: 0,
      },
      registry,
    );
    (globalThis as { __ggui__?: unknown }).__ggui__ = { contexts: registry };

    // 2) Build runtime host.
    const recorder = makeRecordingPoster();
    const ContextStateHost = createContextStateHost({
      react: React,
      poster: recorder.poster,
    });

    // 3) User component reads via the wire hook (real, not mocked).
    const { useGguiContext } = await import('@ggui-ai/wire');
    function User(): React.ReactElement | null {
      const [, setFoo] = useGguiContext<number>('foo');
      React.useEffect(() => {
        setFoo(2);
      }, [setFoo]);
      return null;
    }

    render(
      React.createElement(ContextStateHost, {
        slots: [slot],
        children: React.createElement(User, null),
      }),
    );

    // 4) Spy saw the post for the new value (NOT just the seed).
    // Snapshot format: `[ggui:context] {"foo":2,...}`.
    const newValueUpdates = recorder.updates.filter((params) => {
      const text = params.content?.[0]?.text ?? '';
      return text.startsWith('[ggui:context] ') && text.includes('"foo":2');
    });
    expect(newValueUpdates.length).toBeGreaterThan(0);
    expect(contextSlotLastValues.get('foo')).toBe(2);
  });
});

describe('reemitLastContextValues', () => {
  it('re-posts a single snapshot containing every tracked entry (no filter)', () => {
    // Snapshot semantics. An earlier version fired one post per slot;
    // current behavior is one snapshot post containing all slots. The
    // host treats `ui/update-model-context` as REPLACE, so atomically
    // delivering all slots is correctness-critical.
    contextSlotLastValues.set('currentStep', 3);
    contextSlotLastValues.set('draftText', 'hello');

    const recorder = makeRecordingPoster();
    reemitLastContextValues(recorder.poster);

    expect(recorder.updates).toHaveLength(1);
    const text = recorder.updates[0]?.content?.[0]?.text ?? '';
    expect(text).toContain('"currentStep":3');
    expect(text).toContain('"draftText":"hello"');
    expect(text.startsWith('[ggui:context] ')).toBe(true);
  });

  it('is a no-op when the map is empty', () => {
    const recorder = makeRecordingPoster();
    reemitLastContextValues(recorder.poster);
    expect(recorder.updates).toHaveLength(0);
    expect(recorder.mirrors).toHaveLength(0);
  });

  // Cross-contract leak filter.
  it('drops stale slot names + only re-emits active slots when filter passed', () => {
    contextSlotLastValues.set('foo', 1);
    contextSlotLastValues.set('bar', 2);
    contextSlotLastValues.set('baz', 3);

    const recorder = makeRecordingPoster();
    reemitLastContextValues(recorder.poster, new Set(['baz']));

    // One snapshot post (snapshot mode), containing only the active
    // slot. Stale entries get drained from the map first.
    expect(recorder.updates).toHaveLength(1);
    const text = recorder.updates[0]?.content?.[0]?.text ?? '';
    expect(text).toContain('"baz":3');
    expect(text).not.toContain('"foo"');
    expect(text).not.toContain('"bar"');

    // Map drained of stale entries.
    expect(contextSlotLastValues.has('foo')).toBe(false);
    expect(contextSlotLastValues.has('bar')).toBe(false);
    expect(contextSlotLastValues.has('baz')).toBe(true);
  });
});
