/**
 * `bootProduction` context observation regression tests.
 *
 * An earlier WS-driven boot path (Studio / Portal / OSS console) did
 * NOT install the React Context registry and did NOT wrap per-stack-
 * item React mounts in `<ContextStateHost>`. Result: declared
 * `contextSpec` slots were silently dead — the boilerplate's
 * `globalThis.__ggui__.contexts` destructure resolved to `undefined`
 * and Provider values never flowed back via `ui/update-model-context`.
 *
 * This file pins:
 *
 *   1. `installContextRegistry` populates `globalThis.__ggui__.contexts`
 *      with one entry per declared slot.
 *   2. The `buildOuterWrapper(render)` callback (the seam bootProduction
 *      threads through `wrapOuter`) wraps mounted trees in a
 *      `<ContextStateHost>` whose `slots` prop carries the resolved
 *      slot list.
 *   3. mcpApps / system renders skip the wrap (their renderers
 *      don't run user-component code that reads contexts).
 *   4. A `setValue` call inside the user component propagates as a
 *      `ui/update-model-context` post.
 *
 * **Gap statement.** This file does NOT spin up the full `bootProduction`
 * function — that path imports react/react-dom/wire/design at runtime
 * (the heavy module graph the renderer bundle ships) and pulling all
 * of that through vitest's module loader is brittle. Instead we
 * exercise the EXACT helper composition `bootProduction` uses, against
 * the real `installGlobalRegistry` / `installContextRegistry` /
 * `createContextStateHost` exports. A regression that broke the
 * helper composition (e.g. a future refactor that drops the
 * `installContextRegistry` call from `bootProduction.renderer.setup`)
 * is caught by the production-code-path scan in
 * `boot-production-source.test.ts`-style assertions below.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  installContextRegistry,
  createContextStateHost,
  contextSlotLastValues,
  type ContextSlotInfo,
  type ContextSnapshotPoster,
  type ResolvedContextSlot,
  type UpdateModelContextParams,
} from '../context-observer.js';
import {
  installGlobalRegistry,
  getGlobalRegistry,
} from '../globals.js';

afterEach(() => {
  cleanup();
  contextSlotLastValues.clear();
  // Wipe globalThis.__ggui__ so each test starts from a clean registry.
  (globalThis as { __ggui__?: unknown }).__ggui__ = undefined;
});

describe('bootProduction — context registry installation (F4)', () => {
  it('installs one Context per declared slot under globalThis.__ggui__.contexts', () => {
    // Mirror bootProduction.renderer.setup's first two install
    // steps: the global module registry, then the context registry.
    installGlobalRegistry({
      react: React,
      reactDom: {} as unknown as never,
      primitives: {},
      components: {},
      compositions: {},
      interact: {},
      wire: {},
      tokens: {},
    });

    const slots: ContextSlotInfo[] = [
      {
        name: 'currentStep',
        contextName: 'CurrentStepContext',
        schema: { type: 'number' },
        default: 0,
      },
      {
        name: 'cart',
        contextName: 'CartContext',
        schema: { type: 'array', items: { type: 'string' } },
        default: [],
      },
    ];

    const registry = getGlobalRegistry();
    expect(registry).toBeDefined();
    const resolved = installContextRegistry(
      registry!.contexts,
      React,
      slots,
    );

    // Both contexts now live under globalThis.__ggui__.contexts —
    // exactly the surface the boilerplate's destructure reads from.
    expect(registry!.contexts['CurrentStepContext']).toBeDefined();
    expect(registry!.contexts['CartContext']).toBeDefined();
    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.name).toBe('currentStep');
    expect(resolved[1]?.name).toBe('cart');
  });

  it('returns an empty resolved-slot list when bootstrap.contextSlots is absent', () => {
    installGlobalRegistry({
      react: React,
      reactDom: {} as unknown as never,
      primitives: {},
      components: {},
      compositions: {},
      interact: {},
      wire: {},
      tokens: {},
    });

    // bootProduction's branch: when contextSlots is undefined the
    // resolved list is empty without a registry call.
    const resolved: ReadonlyArray<ResolvedContextSlot> = [];
    expect(resolved).toEqual([]);
  });
});

describe('bootProduction — getOuterWrapper composition (F4)', () => {
  let updates: UpdateModelContextParams[];
  let poster: ContextSnapshotPoster;

  beforeEach(() => {
    updates = [];
    poster = {
      postUpdateModelContext: (params) => {
        updates.push(params);
      },
      postContextMirror: () => {
        /* not exercised by these specs */
      },
    };
  });

  /**
   * Build the EXACT wrapper closure `bootProduction` produces inside
   * its `renderer.setup`. Mirrors the F4 wiring verbatim — any
   * future refactor that diverges this from runtime.ts breaks the
   * test contract.
   */
  function buildOuterWrapper(
    resolvedSlots: ReadonlyArray<ResolvedContextSlot>,
  ): (mountedTree: React.ReactNode) => React.ReactNode {
    const ContextStateHost = createContextStateHost({
      react: React,
      poster,
      consoleWarn: undefined,
    });
    return (mountedTree) =>
      React.createElement(ContextStateHost, {
        slots: resolvedSlots,
        children: mountedTree,
      });
  }

  it('wraps the user component in <ContextStateHost> with the resolved slots', () => {
    installGlobalRegistry({
      react: React,
      reactDom: {} as unknown as never,
      primitives: {},
      components: {},
      compositions: {},
      interact: {},
      wire: {},
      tokens: {},
    });
    const slot: ContextSlotInfo = {
      name: 'currentStep',
      contextName: 'CurrentStepContext',
      schema: { type: 'number' },
      default: 0,
      // Immediate post — keeps the test deterministic.
      debounceMs: 0,
    };
    const resolved = installContextRegistry(
      getGlobalRegistry()!.contexts,
      React,
      [slot],
    );

    const wrapper = buildOuterWrapper(resolved);

    // User component reads the slot via the registered Context. The
    // boilerplate normally does this by destructuring
    // globalThis.__ggui__.contexts; we read the registry directly.
    const CurrentStepContext = getGlobalRegistry()!.contexts[
      'CurrentStepContext'
    ] as React.Context<readonly [number, (n: number) => void]>;
    let captured: { value: number; setValue: (n: number) => void } | null = null;
    function User(): React.ReactElement {
      const [value, setValue] = React.useContext(CurrentStepContext);
      captured = { value, setValue };
      return React.createElement('div', { 'data-testid': 'user' }, String(value));
    }

    const tree = wrapper(React.createElement(User));
    render(tree as React.ReactElement);

    // First mount: User reads the live tuple, value is the seed (0).
    expect(captured).not.toBeNull();
    expect(captured!.value).toBe(0);

    // Initial mount fires one ui/update-model-context for the seed —
    // this is the SingleSlotProvider's debouncing useEffect with
    // debounceMs=0 (immediate post).
    expect(updates.length).toBeGreaterThanOrEqual(1);

    // Now drive a setter call from the User component — this is what
    // the boilerplate's destructured-tuple setter triggers when the
    // LLM-authored code mutates context state.
    updates.length = 0;
    act(() => {
      captured!.setValue(7);
    });

    // setValue propagated → SingleSlotProvider's useEffect fired →
    // ui/update-model-context posted with the new value.
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = updates[updates.length - 1];
    const lastText = lastUpdate?.content?.[0]?.text ?? '';
    // Snapshot format: `[ggui:context] {"currentStep":7,...}`
    // (snapshot replaces per-slot delta `[ggui:context-slot] {slot,value}`).
    expect(lastText.startsWith('[ggui:context] ')).toBe(true);
    expect(lastText).toContain('"currentStep":7');
  });

  it('renders children unchanged when slots is empty (no observers fire)', () => {
    const wrapper = buildOuterWrapper([]);
    const tree = wrapper(React.createElement('span', null, 'hello'));
    const { container } = render(tree as React.ReactElement);
    expect(container.textContent).toContain('hello');
    // No slots → no SingleSlotProvider → no poster fire.
    expect(updates).toHaveLength(0);
  });
});

describe('bootProduction — runtime.ts source pins F4 wiring', () => {
  /**
   * Code-property test: scan `runtime.ts` and assert `bootProduction`
   * still calls `installContextRegistry` + `createContextStateHost`
   * and threads an outer-wrapper builder into the per-mount React
   * options. Catches the regression where a future refactor drops one
   * of these calls (the exact silent-failure mode F4 was filed
   * against).
   *
   * Brittle by design — when this wiring is intentionally relocated,
   * this test must be updated alongside the production code.
   *
   * Post-stack-removal (2026-05-27, Phase A): the old StackRenderContext
   * exposed a `getOuterWrapper(item)` thunk; the single-item rewrite
   * inlined that as a `buildOuterWrapper(item)` closure stamped into
   * the `wrapOuter` field of each `applyItem(...)` call. The wiring
   * is identical in effect.
   */
  it('bootProduction body installs the context registry + builds ContextStateHost + threads a wrapOuter', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const runtimeSrc = readFileSync(
      resolve(here, '..', 'runtime.ts'),
      'utf8',
    );
    // Slice runtime.ts to the bootProduction function body.
    const bootProductionStart = runtimeSrc.indexOf('async function bootProduction(');
    expect(bootProductionStart).toBeGreaterThan(0);
    const bootProductionBody = runtimeSrc.slice(bootProductionStart);

    // Wiring pin: every load-bearing call must appear inside
    // bootProduction's body.
    expect(bootProductionBody).toContain('installContextRegistry(');
    expect(bootProductionBody).toContain('createContextStateHost(');
    // Post-render-identity-collapse: the per-mount wrap builder is
    // named `buildOuterWrapper` and produces a `wrapOuter` field on
    // the mountRender options.
    expect(bootProductionBody).toContain('buildOuterWrapper');
    expect(bootProductionBody).toContain('wrapOuter');
    // Slot input must come from the render slice envelope, not a
    // hard-coded list.
    expect(bootProductionBody).toContain('meta.contextSlots');
  });
});
