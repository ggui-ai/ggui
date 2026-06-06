/**
 * Boilerplate auto-emits `useGguiContext` destructure lines, one per
 * declared `contextSpec` slot. The runtime owns useState + Provider
 * per slot; the boilerplate just gives the LLM `<slotKey>` +
 * `set<SlotKey>` in scope so it can write plain JSX with no useState /
 * no Provider wrap.
 */
import { describe, it, expect } from 'vitest';
import { generateBoilerplate } from './generate';

describe('generateBoilerplate — contextSpec auto-emits useGguiContext', () => {
  it('emits one useGguiContext destructure per declared slot', () => {
    const boilerplate = generateBoilerplate(
      'test prompt',
      {
        contextSpec: {
          currentStep: { schema: { type: 'number' } },
          draftText: { schema: { type: 'string' } },
        },
      },
      'fullscreen',
      'desktop',
    );
    expect(boilerplate).toContain(
      "const [currentStep, setCurrentStep] = useGguiContext<number>('currentStep');",
    );
    expect(boilerplate).toContain(
      "const [draftText, setDraftText] = useGguiContext<string>('draftText');",
    );
  });

  it('imports useGguiContext from @ggui-ai/wire when contextSpec is non-empty', () => {
    const boilerplate = generateBoilerplate(
      'test prompt',
      { contextSpec: { foo: { schema: { type: 'string' } } } },
      'fullscreen',
      'desktop',
    );
    expect(boilerplate).toContain('useGguiContext');
    expect(boilerplate).toContain("from '@ggui-ai/wire'");
  });

  it('does NOT emit Provider wraps anywhere (runtime owns the tree now)', () => {
    const boilerplate = generateBoilerplate(
      'test prompt',
      {
        contextSpec: {
          currentStep: { schema: { type: 'number' } },
        },
      },
      'fullscreen',
      'desktop',
    );
    expect(boilerplate).not.toContain('Context.Provider');
    // No `globalThis.__ggui__.contexts` destructure either — the
    // runtime registry is opaque to the LLM.
    expect(boilerplate).not.toContain('globalThis.__ggui__.contexts');
  });

  it('does NOT emit useState lines for contextSpec slots', () => {
    const boilerplate = generateBoilerplate(
      'test prompt',
      {
        contextSpec: {
          currentStep: { schema: { type: 'number' } },
        },
      },
      'fullscreen',
      'desktop',
    );
    // No useState<T>(0) for the slot — runtime owns it.
    expect(boilerplate).not.toMatch(
      /const \[currentStep, setCurrentStep\] = useState</,
    );
  });

  it('emits hook lines in declaration order', () => {
    const boilerplate = generateBoilerplate(
      'test prompt',
      {
        contextSpec: {
          currentStep: { schema: { type: 'number' } },
          draftText: { schema: { type: 'string' } },
        },
      },
      'fullscreen',
      'desktop',
    );
    const stepIdx = boilerplate.indexOf(
      "const [currentStep, setCurrentStep]",
    );
    const draftIdx = boilerplate.indexOf("const [draftText, setDraftText]");
    expect(stepIdx).toBeGreaterThan(-1);
    expect(draftIdx).toBeGreaterThan(stepIdx);
  });

  it('emits no useGguiContext lines when contextSpec is absent', () => {
    const boilerplate = generateBoilerplate(
      'test prompt',
      {},
      'fullscreen',
      'desktop',
    );
    expect(boilerplate).not.toContain('useGguiContext');
  });

  it('emits no useGguiContext lines when contextSpec is empty', () => {
    const boilerplate = generateBoilerplate(
      'test prompt',
      { contextSpec: {} },
      'fullscreen',
      'desktop',
    );
    expect(boilerplate).not.toContain('useGguiContext');
  });

  it('emits no leftover {{CONTEXT_*}} marker tokens', () => {
    const boilerplate = generateBoilerplate(
      'test',
      {
        contextSpec: { stepIndex: { schema: { type: 'number' } } },
      },
      'fullscreen',
      'desktop',
    );
    expect(boilerplate).not.toContain('{{CONTEXT_HOOKS}}');
    // Old marker names must not survive in the template.
    expect(boilerplate).not.toContain('{{CONTEXT_DESTRUCTURE}}');
    expect(boilerplate).not.toContain('{{CONTEXT_USESTATE}}');
    expect(boilerplate).not.toContain('{{CONTEXT_PROVIDER_OPEN}}');
    expect(boilerplate).not.toContain('{{CONTEXT_PROVIDER_CLOSE}}');
  });

  it('uses jsonSchemaTypeToTs for type narrowing per slot', () => {
    const boilerplate = generateBoilerplate(
      'test',
      {
        contextSpec: {
          flag: { schema: { type: 'boolean' } },
          tags: { schema: { type: 'array', items: { type: 'string' } } },
        },
      },
      'fullscreen',
      'desktop',
    );
    expect(boilerplate).toContain('useGguiContext<boolean>');
    expect(boilerplate).toContain('useGguiContext<string[]>');
  });
});

describe('generateBoilerplate — clientCapabilities.gadgets emits direct gadget imports', () => {
  // `loadGadgets()` is RETIRED. The boilerplate
  // now DIRECT-imports each gadget export: a `// DO NOT EDIT — gadget
  // imports` banner line, then one combined `import { hookA, hookB }
  // from '<package>';` per registered gadget package (packages sorted,
  // hooks sorted within each package). The body-level
  // `const { … } = loadGadgets();` destructure is gone; the
  // `const binding = hook(...)` call sites are unchanged.

  it('emits the DO NOT EDIT gadget-imports banner', () => {
    const boilerplate = generateBoilerplate(
      'test',
      {
        clientCapabilities: {
          gadgets: {
            '@ggui-ai/gadgets': { useMicrophone: {} },
          },
        },
      },
      'fullscreen',
      'desktop',
    );
    // The banner warns the LLM the import line is runtime-resolved
    // and must not be deleted.
    expect(boilerplate).toContain('// DO NOT EDIT — gadget imports.');
    expect(boilerplate).toContain('gadget_preservation:<export>');
    // The retired accessor must not appear anywhere.
    expect(boilerplate).not.toContain('loadGadgets');
  });

  it('emits ONE combined import per package with hooks sorted alphabetically', () => {
    const boilerplate = generateBoilerplate(
      'test',
      {
        clientCapabilities: {
          gadgets: {
            '@ggui-ai/gadgets': { useMicrophone: {}, useCamera: {} },
          },
        },
      },
      'fullscreen',
      'desktop',
    );
    // Two hooks, same package → one combined import, hooks sorted.
    expect(boilerplate).toContain(
      "import { useCamera, useMicrophone } from '@ggui-ai/gadgets';",
    );
    // Exactly one import line from the package — not one per hook.
    expect(
      boilerplate.match(/import \{[^}]*\} from '@ggui-ai\/gadgets';/g)?.length,
    ).toBe(1);
  });

  it('emits the call site for each declared library', () => {
    const boilerplate = generateBoilerplate(
      'test',
      {
        clientCapabilities: {
          gadgets: {
            '@ggui-ai/gadgets': {
              useGeolocation: { description: 'lat/long reader' },
            },
          },
        },
      },
      'fullscreen',
      'desktop',
    );
    // The direct import binds the hook; the call site invokes it.
    // The binding name is derived from the hook name
    // (`useGeolocation` → `geolocation`) — the wire no longer carries
    // an explicit binding name.
    expect(boilerplate).toContain(
      "import { useGeolocation } from '@ggui-ai/gadgets';",
    );
    expect(boilerplate).toContain('const geolocation = useGeolocation();');
  });

  it('emits no library imports when clientCapabilities is absent', () => {
    const boilerplate = generateBoilerplate('test', {}, 'fullscreen', 'desktop');
    expect(boilerplate).not.toContain('@ggui-ai/gadgets');
    expect(boilerplate).not.toContain('DO NOT EDIT — gadget imports');
  });

  it('emits no library imports when libraries map is empty', () => {
    const boilerplate = generateBoilerplate(
      'test',
      { clientCapabilities: { gadgets: {} } },
      'fullscreen',
      'desktop',
    );
    expect(boilerplate).not.toContain('@ggui-ai/gadgets');
    expect(boilerplate).not.toContain('DO NOT EDIT — gadget imports');
  });

  it('direct-imports a 3rd-party wrapper hook from its own package', () => {
    const boilerplate = generateBoilerplate(
      'show a delivery map',
      {
        clientCapabilities: {
          gadgets: {
            '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
          },
        },
      },
      'fullscreen',
      'desktop',
      undefined,
      [
        {
          package: '@ggui-samples/gadget-leaflet',
          version: '0.0.1',
          exports: [
            {
              hook: 'useLeafletMap',
              description: 'Interactive Leaflet map',
              usage: 'Mount when the intent names a rendered map',
            },
          ],
        },
      ],
    );
    // The hook is imported DIRECTLY from the wrapper package — not from
    // `@ggui-ai/gadgets`, not via a `loadGadgets()` accessor.
    expect(boilerplate).toContain(
      "import { useLeafletMap } from '@ggui-samples/gadget-leaflet';",
    );
    expect(boilerplate).not.toContain('loadGadgets');
    expect(boilerplate).toContain('const leafletMap = useLeafletMap();');
  });

  it('never emits URL imports — runtime resolves bundles, not source code', () => {
    // Pre-1.2.8 the bundleUrl path emitted
    //   `import { useLeafletMap } from 'https://...'`
    // The boilerplate direct-imports from the package SPECIFIER; the
    // iframe rewriter rewrites that specifier to a per-package shim. URL
    // imports remain banned at the source level regardless.
    const boilerplate = generateBoilerplate(
      'test',
      {
        clientCapabilities: {
          gadgets: {
            '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
          },
        },
      },
      'fullscreen',
      'desktop',
      undefined,
      [
        {
          package: '@ggui-samples/gadget-leaflet',
          version: '0.0.1',
          bundleUrl: 'https://registry.ggui.ai/leaflet@0.0.1/bundle.js',
          exports: [{ hook: 'useLeafletMap' }],
        },
      ],
    );
    expect(boilerplate).not.toMatch(/from 'https?:\/\//);
    // The import is the bare package specifier — not the bundle URL.
    expect(boilerplate).toContain(
      "import { useLeafletMap } from '@ggui-samples/gadget-leaflet';",
    );
  });

  it('STDLIB hooks ride the same direct-import path from @ggui-ai/gadgets', () => {
    const boilerplate = generateBoilerplate(
      'test',
      {
        clientCapabilities: {
          gadgets: {
            '@ggui-ai/gadgets': { useGeolocation: {} },
          },
        },
      },
      'fullscreen',
      'desktop',
    );
    // No special-casing for STDLIB — they direct-import from
    // `@ggui-ai/gadgets` exactly like 3rd-party wrappers from theirs.
    expect(boilerplate).toContain(
      "import { useGeolocation } from '@ggui-ai/gadgets';",
    );
    expect(boilerplate).not.toContain('loadGadgets');
  });

  it('groups hooks per package and sorts packages alphabetically', () => {
    // Two packages declared → two separate combined imports, packages
    // sorted alphabetically for stable diffs across same-contract regens.
    const boilerplate = generateBoilerplate(
      'test',
      {
        clientCapabilities: {
          gadgets: {
            '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
            '@ggui-ai/gadgets': { useGeolocation: {} },
          },
        },
      },
      'fullscreen',
      'desktop',
    );
    const ggIdx = boilerplate.indexOf(
      "import { useGeolocation } from '@ggui-ai/gadgets';",
    );
    const leafletIdx = boilerplate.indexOf(
      "import { useLeafletMap } from '@ggui-samples/gadget-leaflet';",
    );
    expect(ggIdx).toBeGreaterThan(-1);
    expect(leafletIdx).toBeGreaterThan(-1);
    // `@ggui-ai/gadgets` sorts before `@ggui-samples/gadget-leaflet`.
    expect(ggIdx).toBeLessThan(leafletIdx);
  });

  it('emits no REQUIRED markers and no loadGadgets accessor', () => {
    const boilerplate = generateBoilerplate(
      'show a delivery map',
      {
        clientCapabilities: {
          gadgets: {
            '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
          },
        },
      },
      'fullscreen',
      'desktop',
      undefined,
      [
        {
          package: '@ggui-samples/gadget-leaflet',
          version: '0.0.1',
          exports: [{ hook: 'useLeafletMap' }],
        },
      ],
    );
    // The per-line REQUIRED marker is gone; the `loadGadgets()`
    // accessor is also retired. The `DO NOT EDIT — gadget
    // imports` banner + tier-0 `gadget_preservation` do the protective
    // work now.
    expect(boilerplate).not.toContain('// REQUIRED — registered gadget import');
    expect(boilerplate).not.toContain('loadGadgets');
  });

  it('collapses two hooks of one wrapper into a single combined import', () => {
    // The same wrapper can declare multiple hooks; each gets its own
    // contract entry but they collapse into ONE combined import line.
    const boilerplate = generateBoilerplate(
      'test',
      {
        clientCapabilities: {
          gadgets: {
            '@ggui-samples/gadget-leaflet': {
              useLeafletMap: {},
              useLeafletMarkers: {},
            },
          },
        },
      },
      'fullscreen',
      'desktop',
      undefined,
      [
        {
          package: '@ggui-samples/gadget-leaflet',
          version: '0.0.1',
          exports: [
            { hook: 'useLeafletMap' },
            { hook: 'useLeafletMarkers' },
          ],
        },
      ],
    );
    // One combined import, hooks sorted alphabetically.
    expect(boilerplate).toContain(
      "import { useLeafletMap, useLeafletMarkers } from '@ggui-samples/gadget-leaflet';",
    );
    // Exactly ONE import statement for the wrapper — not per-hook.
    expect(
      boilerplate.match(
        /import \{[^}]*\} from '@ggui-samples\/gadget-leaflet';/g,
      )?.length,
    ).toBe(1);
  });

  it('direct-imports a component gadget with NO pre-emitted call site', () => {
    const boilerplate = generateBoilerplate(
      'show a delivery map',
      {
        clientCapabilities: {
          gadgets: {
            '@ggui-samples/gadget-leaflet': { LeafletMap: {} },
          },
        },
      },
      'fullscreen',
      'desktop',
      undefined,
      [
        {
          package: '@ggui-samples/gadget-leaflet',
          version: '0.0.1',
          exports: [
            {
              component: 'LeafletMap',
              description: 'Interactive Leaflet map',
              usage: 'Render when the intent names a rendered map',
            },
          ],
        },
      ],
    );
    // The component is direct-imported from its package, under the
    // same `DO NOT EDIT` banner as hook gadgets.
    expect(boilerplate).toContain(
      "import { LeafletMap } from '@ggui-samples/gadget-leaflet';",
    );
    expect(boilerplate).toContain('// DO NOT EDIT — gadget imports.');
    // A component is RENDERED, not called — no pre-emitted
    // `const map = LeafletMap(...)` call site (unlike hook gadgets).
    expect(boilerplate).not.toContain('= LeafletMap(');
  });
});
