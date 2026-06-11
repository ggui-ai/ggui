/**
 * Tests for the `globalThis.__ggui__` registry install.
 *
 * The registry is the seam generated code's data-URL shims read
 * from — so the lock points are: (1) every module key is present
 * after install; (2) legacy window globals are populated as a
 * fallback; (3) re-install replaces module slots wholesale while
 * preserving the `contexts` sub-object (idempotent).
 */
import { describe, it, expect } from 'vitest';
import { installGlobalRegistry, getGlobalRegistry } from '../globals.js';

function makeFakeTarget(): typeof globalThis {
  // Fresh record per spec — avoids polluting the real `globalThis`
  // across tests and lets assertions inspect legacy keys without
  // leakage into later specs.
  return {} as unknown as typeof globalThis;
}

describe('installGlobalRegistry — shape', () => {
  it('installs a registry with the seven required module keys', () => {
    const target = makeFakeTarget();
    installGlobalRegistry(
      {
        react: { __id: 'react-fake' },
        reactDom: { __id: 'reactDom-fake' },
        primitives: { __id: 'primitives-fake' },
        components: { __id: 'components-fake' },
        compositions: { __id: 'compositions-fake' },
        interact: { __id: 'interact-fake' },
        wire: { __id: 'wire-fake' },
        tokens: { __id: 'tokens-fake' },
      },
      target,
    );

    const registry = getGlobalRegistry(target);
    expect(registry).toBeDefined();
    expect(registry?.react).toEqual({ __id: 'react-fake' });
    expect(registry?.reactDom).toEqual({ __id: 'reactDom-fake' });
    expect(registry?.primitives).toEqual({ __id: 'primitives-fake' });
    expect(registry?.components).toEqual({ __id: 'components-fake' });
    expect(registry?.compositions).toEqual({ __id: 'compositions-fake' });
    expect(registry?.interact).toEqual({ __id: 'interact-fake' });
    expect(registry?.wire).toEqual({ __id: 'wire-fake' });
  });

  it('installs publicEnv slot (Slice 2.3) from opts', () => {
    const target = makeFakeTarget();
    installGlobalRegistry(
      {
        react: {},
        reactDom: {},
        primitives: {},
        components: {},
        compositions: {},
        interact: {},
        wire: {},
        tokens: {},
        publicEnv: { GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' },
      },
      target,
    );
    const registry = getGlobalRegistry(target);
    expect(registry?.publicEnv).toEqual({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
    });
    // Legacy global also populated for console debugging parity.
    const legacy = target as { [k: string]: unknown };
    expect(legacy['__GGUI_PUBLIC_ENV']).toEqual({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
    });
  });

  it('defaults publicEnv to {} when opts omits it (Slice 2.3 back-compat)', () => {
    const target = makeFakeTarget();
    installGlobalRegistry(
      {
        react: {},
        reactDom: {},
        primitives: {},
        components: {},
        compositions: {},
        interact: {},
        wire: {},
        tokens: {},
      },
      target,
    );
    const registry = getGlobalRegistry(target);
    expect(registry?.publicEnv).toEqual({});
  });

  it('populates legacy window globals as fallback (__REACT, __GGUI_PRIMITIVES, etc.)', () => {
    // Historic rewrite-imports.ts shims fall back to window[legacyName]
    // when globalThis.__ggui__[key] is missing. We populate both so
    // cached generated code from before the __ggui__ consolidation
    // keeps resolving.
    const target = makeFakeTarget();
    installGlobalRegistry(
      {
        react: { r: 1 },
        reactDom: { rd: 1 },
        primitives: { p: 1 },
        components: { c: 1 },
        compositions: { cp: 1 },
        interact: { i: 1 },
        wire: { w: 1 },
        tokens: { t: 1 },
      },
      target,
    );

    const legacy = target as { [k: string]: unknown };
    expect(legacy['__REACT']).toEqual({ r: 1 });
    expect(legacy['__GGUI_PRIMITIVES']).toEqual({ p: 1 });
    expect(legacy['__GGUI_COMPONENTS']).toEqual({ c: 1 });
    expect(legacy['__GGUI_COMPOSITIONS']).toEqual({ cp: 1 });
    expect(legacy['__GGUI_INTERACT']).toEqual({ i: 1 });
  });
});

describe('installGlobalRegistry — idempotency', () => {
  it('replaces module slots wholesale on re-install', () => {
    const target = makeFakeTarget();

    // First install.
    installGlobalRegistry(
      {
        react: { id: 'first' },
        reactDom: {},
        primitives: {},
        components: {},
        compositions: {},
        interact: {},
        wire: {},
        tokens: {},
      },
      target,
    );

    // Second install — module slots swap wholesale; the `contexts`
    // sub-object is the ONE thing reused across re-installs so the
    // LLM-authored component's destructured Context references stay
    // live (see installGlobalRegistry docstring).
    installGlobalRegistry(
      {
        react: { id: 'second' },
        reactDom: {},
        primitives: {},
        components: {},
        compositions: {},
        interact: {},
        wire: {},
        tokens: {},
      },
      target,
    );

    const second = getGlobalRegistry(target);
    expect(second?.react).toEqual({ id: 'second' });
  });
});

describe('getGlobalRegistry — absence', () => {
  it('returns undefined when no registry has been installed', () => {
    const target = makeFakeTarget();
    expect(getGlobalRegistry(target)).toBeUndefined();
  });
});

describe('installGlobalRegistry — Slice 8 contexts subregistry', () => {
  it('seeds an empty contexts record on first install', () => {
    const target = makeFakeTarget();
    installGlobalRegistry(
      {
        react: {},
        reactDom: {},
        primitives: {},
        components: {},
        compositions: {},
        interact: {},
        wire: {},
        tokens: {},
      },
      target,
    );
    const registry = getGlobalRegistry(target);
    expect(registry?.contexts).toEqual({});
  });

  it('PRESERVES the contexts record across re-installs (re-mount idempotency)', () => {
    // The LLM's destructured Context references must remain stable
    // across re-mounts — `installGlobalRegistry` re-uses the existing
    // `contexts` sub-object when a previous registry is present.
    const target = makeFakeTarget();
    installGlobalRegistry(
      {
        react: {},
        reactDom: {},
        primitives: {},
        components: {},
        compositions: {},
        interact: {},
        wire: {},
        tokens: {},
      },
      target,
    );
    const first = getGlobalRegistry(target);
    expect(first?.contexts).toBeDefined();
    // Simulate the runtime registering a Context.
    const sentinel = { __sentinel: 'live' } as unknown;
    (first?.contexts as Record<string, unknown>)['CurrentStepContext'] = sentinel;

    installGlobalRegistry(
      {
        react: {},
        reactDom: {},
        primitives: {},
        components: {},
        compositions: {},
        interact: {},
        wire: {},
        tokens: {},
      },
      target,
    );
    const second = getGlobalRegistry(target);
    // Same sub-object reference, not a fresh `{}`.
    expect(second?.contexts).toBe(first?.contexts);
    expect((second?.contexts as Record<string, unknown>)['CurrentStepContext']).toBe(
      sentinel,
    );
  });
});

describe('installGlobalRegistry — gadgets slot (GG.8.2 per-package)', () => {
  // The per-package data-URL shim in
  // `@ggui-ai/design/rendering/rewrite-imports.ts` reads from
  // `globalThis.__ggui__.gadgets[package][export]` for
  // `import { useGeolocation } from '@ggui-ai/gadgets'`. The slot is a
  // `GadgetPackageRegistry` — package name → that package's whole
  // loaded module namespace. These tests pin the slot's semantics so
  // the production boot wiring (`runtime.ts:bootProduction`) stays
  // correct.

  it('populates the gadgets slot from the install options', () => {
    const target = makeFakeTarget();
    const stdlibNamespace = {
      useGeolocation: () => ({ status: 'idle' }),
      useCamera: () => ({ status: 'idle' }),
    };
    const fakeGadgets = { '@ggui-ai/gadgets': stdlibNamespace };
    installGlobalRegistry(
      {
        react: {},
        reactDom: {},
        primitives: {},
        components: {},
        compositions: {},
        interact: {},
        wire: {},
        tokens: {},
        gadgets: fakeGadgets,
      },
      target,
    );

    const registry = getGlobalRegistry(target);
    expect(registry?.gadgets).toBe(fakeGadgets);
    // The whole STDLIB namespace is reachable under its package key.
    expect(registry?.gadgets['@ggui-ai/gadgets']).toBe(stdlibNamespace);
    // The legacy global is populated symmetric with __REACT etc., so
    // console-debugging works (window.__GGUI_CLIENT_LIBRARIES).
    expect(
      (target as { __GGUI_CLIENT_LIBRARIES?: unknown })
        .__GGUI_CLIENT_LIBRARIES,
    ).toBe(fakeGadgets);
  });

  it('defaults the gadgets slot to an empty record when omitted', () => {
    // Backwards-compatibility for callers that don't bind gadgets (and
    // for tests). The slot exists but is empty — any package lookup
    // returns undefined; the LLM's `useGeolocation()` call would throw
    // at runtime, which is the correct posture for "operator hasn't
    // seeded the registry."
    const target = makeFakeTarget();
    installGlobalRegistry(
      {
        react: {},
        reactDom: {},
        primitives: {},
        components: {},
        compositions: {},
        interact: {},
        wire: {},
        tokens: {},
      },
      target,
    );
    const registry = getGlobalRegistry(target);
    expect(registry?.gadgets).toEqual({});
  });

  it('replaces the gadgets slot wholesale on re-install (no per-mount merge)', () => {
    // Unlike `contexts` (which preserves React Context references across
    // re-mounts), gadgets is a stable package-name -> namespace map. A
    // re-install replaces it wholesale — the LLM's destructured imports
    // resolve from the shim at module-load time, so re-mounts pick up
    // the new registry the next time the shim module loads.
    const target = makeFakeTarget();
    installGlobalRegistry(
      {
        react: {}, reactDom: {}, primitives: {}, components: {},
        compositions: {}, interact: {}, wire: {}, tokens: {},
        gadgets: {
          '@ggui-ai/gadgets': { useGeolocation: () => 'v1' },
        },
      },
      target,
    );
    installGlobalRegistry(
      {
        react: {}, reactDom: {}, primitives: {}, components: {},
        compositions: {}, interact: {}, wire: {}, tokens: {},
        gadgets: {
          '@ggui-ai/gadgets': { useGeolocation: () => 'v2' },
          '@ggui-samples/gadget-leaflet': { useLeafletMap: () => 'plugin' },
        },
      },
      target,
    );
    const registry = getGlobalRegistry(target);
    const stdlibNs = registry?.gadgets['@ggui-ai/gadgets'] as Record<
      string,
      () => string
    >;
    const leafletNs = registry?.gadgets[
      '@ggui-samples/gadget-leaflet'
    ] as Record<string, () => string>;
    expect(stdlibNs['useGeolocation']?.()).toBe('v2');
    expect(leafletNs['useLeafletMap']?.()).toBe('plugin');
  });
});
