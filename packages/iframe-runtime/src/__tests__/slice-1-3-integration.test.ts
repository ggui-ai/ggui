// GG.8.2 — integration proof gate for the full gadget pipeline. Wires
// every gadget surface together and asserts the stack passes data
// end-to-end:
//
//   1. Bootstrap envelope carries `gadgets: [{package, bundleUrl?,
//      bundleSri?}]` (the parser handles + propagates the field)
//   2. `loadGadgetRegistry` composes the STDLIB seed + each registered
//      package namespace via an injected importer
//   3. `installGlobalRegistry` plants the result at
//      `globalThis.__ggui__.gadgets` as a per-package registry
//   4. Generated component code direct-imports gadget exports; the
//      per-package data-URL shim resolves
//      `globalThis.__ggui__.gadgets[package][export]` at call/render
//      time. `loadGadgets()` is RETIRED — no Proxy.
//
// The Leaflet render-side e2e (real bundle in real iframe with CSP)
// stays deferred to a follow-up — needs internet + a hosted bundle.
// This test is the structural proof gate: every wire seam carries the
// right value into the next stage.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseBootstrap } from '../bootstrap.js';
import {
  loadGadgetRegistry,
  type DynamicImporter,
} from '../gadget-loader.js';
import {
  installGlobalRegistry,
  getGlobalRegistry,
  type ModuleNamespace,
} from '../globals.js';

afterEach(() => {
  // Reset the global registry between tests so a package installed
  // in one test doesn't leak into another via the cached __ggui__.
  delete (globalThis as { __ggui__?: unknown }).__ggui__;
});

function buildBootstrapEnvelope(
  gadgets?: ReadonlyArray<{
    package: string;
    bundleUrl?: string;
    bundleSri?: string;
  }>,
) {
  return {
    toolOutput: {
      _meta: {
        ggui: {
          bootstrap: {
            wsUrl: 'wss://server.example/ws',
            token: 'tok_abc',
            sessionId: 'sess_001',
            appId: 'app_001',
            runtimeUrl: '/_ggui/iframe-runtime.js',
            ...(gadgets !== undefined ? { gadgets } : {}),
          },
        },
      },
      structuredContent: { sessionId: 'sess_001' },
    },
  };
}

function makeFakeStdlib(): ModuleNamespace {
  // Mock STDLIB namespace — same shape the real `@ggui-ai/gadgets`
  // module exposes (one callable per STDLIB hook). Tests only need the
  // keys; values can be sentinel functions.
  return {
    useGeolocation: () => 'fake-geo',
    useCamera: () => 'fake-cam',
    useMicrophone: () => 'fake-mic',
    useClipboardWrite: () => 'fake-clipwrite',
    useClipboardPaste: () => 'fake-clippaste',
    useFilePicker: () => 'fake-filepicker',
    useNotifications: () => 'fake-notify',
  };
}

describe('GG.8.2 — full gadget pipeline (per-package)', () => {
  it('STDLIB-only contract: parser → loader → install → per-package registry', async () => {
    // (1) Parse a bootstrap without a gadgets field.
    const parsed = parseBootstrap(buildBootstrapEnvelope());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unexpected');
    expect(parsed.bootstrap.gadgets).toBeUndefined();

    // (2) Compose registry with empty package list — STDLIB only.
    const stdlib = makeFakeStdlib();
    const registry = await loadGadgetRegistry(
      stdlib,
      parsed.bootstrap.gadgets ?? [],
    );

    // (3) Install on globalThis.
    installGlobalRegistry({
      react: {},
      reactDom: {},
      primitives: {},
      components: {},
      compositions: {},
      interact: {},
      tokens: {},
      wire: {},
      gadgets: registry,
    });

    // (4) The runtime registry surfaces the STDLIB namespace under its
    // package key — what the per-package data-URL shim reads.
    const gadgets = getGlobalRegistry()?.gadgets;
    expect(gadgets).toBeDefined();
    const stdlibNs = gadgets?.['@ggui-ai/gadgets'];
    expect(stdlibNs?.['useGeolocation']).toBe(stdlib.useGeolocation);
    // No package was registered for a 3rd-party gadget, so its slot is
    // simply absent — the shim for an unregistered package would have
    // no entry to resolve against.
    expect(gadgets?.['@ggui-samples/gadget-leaflet']).toBeUndefined();
  });

  it('wrapper contract: bootstrap → parser → dynamic import → per-package registry', async () => {
    // (1) Parse a bootstrap WITH a registered package.
    const parsed = parseBootstrap(
      buildBootstrapEnvelope([
        {
          package: '@ggui-samples/gadget-leaflet',
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unexpected');
    expect(parsed.bootstrap.gadgets).toEqual([
      {
        package: '@ggui-samples/gadget-leaflet',
      },
    ]);

    // (2) Compose registry with an injected importer that returns the
    // fake package namespace. Production passes `(t) => import(t)`;
    // tests inject so no real network / module-resolution is needed.
    const useLeafletFake = () => 'fake-leaflet-instance';
    const leafletNamespace: ModuleNamespace = {
      useLeafletMap: useLeafletFake,
      LeafletMap: () => null,
    };
    const fakeImporter: DynamicImporter = async (target) => {
      if (target === '@ggui-samples/gadget-leaflet') {
        return leafletNamespace;
      }
      throw new Error(`unexpected import: ${target}`);
    };
    const stdlib = makeFakeStdlib();
    const registry = await loadGadgetRegistry(
      stdlib,
      parsed.bootstrap.gadgets ?? [],
      { importer: fakeImporter, logger: { warn: vi.fn() } },
    );

    // (3) Install on globalThis.
    installGlobalRegistry({
      react: {},
      reactDom: {},
      primitives: {},
      components: {},
      compositions: {},
      interact: {},
      tokens: {},
      wire: {},
      gadgets: registry,
    });

    // (4) The runtime registry surfaces BOTH the STDLIB namespace AND
    // the registered package namespace, each under its package key.
    const gadgets = getGlobalRegistry()?.gadgets;
    expect(gadgets?.['@ggui-ai/gadgets']?.['useGeolocation']).toBe(
      stdlib.useGeolocation,
    );
    const leafletNs = gadgets?.['@ggui-samples/gadget-leaflet'];
    expect(leafletNs).toBe(leafletNamespace);
    expect(leafletNs?.['useLeafletMap']).toBe(useLeafletFake);

    // The per-package shim resolution pattern (what the rewriter emits
    // for a direct gadget import) works: package-keyed export lookup.
    const useLeafletMap = gadgets?.['@ggui-samples/gadget-leaflet']?.[
      'useLeafletMap'
    ] as () => string;
    const useGeolocation = gadgets?.['@ggui-ai/gadgets']?.[
      'useGeolocation'
    ] as () => string;
    expect(useLeafletMap()).toBe('fake-leaflet-instance');
    expect(useGeolocation()).toBe('fake-geo');
  });

  it('package load failure leaves its slot absent (other slots intact)', async () => {
    const parsed = parseBootstrap(
      buildBootstrapEnvelope([
        {
          package: '@broken/wrapper',
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unexpected');

    const failingImporter: DynamicImporter = async () => {
      throw new Error('network error');
    };
    const stdlib = makeFakeStdlib();
    const registry = await loadGadgetRegistry(
      stdlib,
      parsed.bootstrap.gadgets ?? [],
      { importer: failingImporter, logger: { warn: vi.fn() } },
    );

    installGlobalRegistry({
      react: {},
      reactDom: {},
      primitives: {},
      components: {},
      compositions: {},
      interact: {},
      tokens: {},
      wire: {},
      gadgets: registry,
    });

    const gadgets = getGlobalRegistry()?.gadgets;
    // STDLIB still works.
    expect(gadgets?.['@ggui-ai/gadgets']?.['useGeolocation']).toBe(
      stdlib.useGeolocation,
    );
    // The failed package has no slot — the rewriter's per-package shim
    // would throw a clear "not loaded" error at call/render time
    // instead of silently crashing inside React.
    expect(gadgets?.['@broken/wrapper']).toBeUndefined();
  });

  it('STDLIB wins on collision: an operator package named @ggui-ai/gadgets cannot shadow first-party', async () => {
    const parsed = parseBootstrap(
      buildBootstrapEnvelope([
        {
          package: '@ggui-ai/gadgets',
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unexpected');

    const evilImporter: DynamicImporter = async () => ({
      useGeolocation: () => 'EVIL',
    });
    const stdlib = makeFakeStdlib();
    const registry = await loadGadgetRegistry(
      stdlib,
      parsed.bootstrap.gadgets ?? [],
      { importer: evilImporter, logger: { warn: vi.fn() } },
    );

    installGlobalRegistry({
      react: {},
      reactDom: {},
      primitives: {},
      components: {},
      compositions: {},
      interact: {},
      tokens: {},
      wire: {},
      gadgets: registry,
    });

    const gadgets = getGlobalRegistry()?.gadgets;
    // The STDLIB namespace is NOT replaced by the operator's
    // same-named package.
    expect(gadgets?.['@ggui-ai/gadgets']).toBe(stdlib);
    const useGeolocation = gadgets?.['@ggui-ai/gadgets']?.[
      'useGeolocation'
    ] as () => string;
    expect(useGeolocation()).toBe('fake-geo');
  });
});
