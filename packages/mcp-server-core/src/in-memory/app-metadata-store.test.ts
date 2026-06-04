import { describe, expect, it } from 'vitest';
import { STDLIB_GADGETS, type GadgetDescriptor } from '@ggui-ai/protocol';
import { InMemoryAppMetadataStore } from './app-metadata-store.js';

/**
 * Schema-valid base — GG.8.1: a `GadgetDescriptor` is a PACKAGE
 * bundling `exports[]`. The strict `strictGadgetDescriptorSchema`
 * requires `description`, `usage`, `example` on each export, plus
 * `package` + `version`. `hook` names the single hook export; `overrides`
 * carries package-level fields.
 */
function makeGadget(
  overrides: Partial<GadgetDescriptor> & { hook?: string } = {},
): GadgetDescriptor {
  const { hook = 'useTestGadget', ...packageOverrides } = overrides;
  return {
    package: '@acme/test',
    version: '0.0.1',
    exports: [
      {
        hook,
        description: 'Test gadget for unit tests',
        usage: 'const t = useTestGadget(); return <div ref={t.ref} />;',
        example: '{ "hook": "useTestGadget" }',
      },
    ],
    ...packageOverrides,
  };
}

describe('InMemoryAppMetadataStore', () => {
  it('returns null for unregistered apps', async () => {
    const store = new InMemoryAppMetadataStore();
    expect(await store.get('does-not-exist')).toBeNull();
  });

  it('registers apps seeded with STDLIB_GADGETS by default', async () => {
    const store = new InMemoryAppMetadataStore();
    store.register('app-1');
    const app = await store.get('app-1');
    expect(app).not.toBeNull();
    expect(app?.id).toBe('app-1');
    // Identity equality: by default the store reuses the stdlib
    // descriptor array without cloning — callers MUST treat it as
    // readonly.
    expect(app?.gadgets).toBe(STDLIB_GADGETS);
  });

  it('accepts explicit gadgets on registration', async () => {
    const store = new InMemoryAppMetadataStore();
    const custom = [makeGadget({ hook: 'useCustom', package: '@acme/custom-hooks' })];
    store.register('app-1', { gadgets: custom });
    const app = await store.get('app-1');
    expect(app?.gadgets).toBe(custom);
  });

  it('register() replaces an existing app entry', async () => {
    const store = new InMemoryAppMetadataStore();
    store.register('app-1');
    const custom = [makeGadget({ hook: 'useNew', package: '@acme/new' })];
    store.register('app-1', { gadgets: custom });
    const app = await store.get('app-1');
    expect(app?.gadgets).toBe(custom);
  });

  it('getOrCreate() seeds stdlib on first access', async () => {
    const store = new InMemoryAppMetadataStore();
    const app = store.getOrCreate('app-1');
    expect(app.gadgets).toBe(STDLIB_GADGETS);
    // Second call returns the same record (no re-seed).
    const app2 = store.getOrCreate('app-1');
    expect(app2).toBe(app);
  });

  it('getOrCreate() preserves a previously-registered custom catalog', async () => {
    const store = new InMemoryAppMetadataStore();
    const custom = [makeGadget({ hook: 'useCustom', package: '@acme/x' })];
    store.register('app-1', { gadgets: custom });
    const app = store.getOrCreate('app-1');
    expect(app.gadgets).toBe(custom);
  });

  describe('defaults fall-through on get()', () => {
    it('returns a default-bearing App for unregistered appIds when defaultThemeId is set', async () => {
      const store = new InMemoryAppMetadataStore({ defaultThemeId: 'claudic' });
      const app = await store.get('never-registered');
      expect(app).not.toBeNull();
      expect(app?.id).toBe('never-registered');
      expect(app?.defaultThemeId).toBe('claudic');
      expect(app?.gadgets).toBe(STDLIB_GADGETS);
    });

    it('returns a default-bearing App for unregistered appIds when availableThemeIds is set', async () => {
      const store = new InMemoryAppMetadataStore({
        availableThemeIds: ['ggui', 'claudic'],
      });
      const app = await store.get('never-registered');
      expect(app).not.toBeNull();
      expect(app?.availableThemeIds).toEqual(['ggui', 'claudic']);
      expect(app?.defaultThemeId).toBeUndefined();
    });

    it('still returns null for unregistered appIds when no defaults are set', async () => {
      const store = new InMemoryAppMetadataStore();
      expect(await store.get('never-registered')).toBeNull();
    });

    it('explicit register() wins over defaults fall-through', async () => {
      const store = new InMemoryAppMetadataStore({ defaultThemeId: 'claudic' });
      store.register('app-1', { defaultThemeId: 'ggui' });
      const app = await store.get('app-1');
      expect(app?.defaultThemeId).toBe('ggui');
    });

    // Slice 2.5 audit fix — defaults.defaultGadgets was
    // previously missing from the constructor signature, so CLI
    // single-tenant hosts that declared `ggui.json#app.gadgets`
    // silently fell back to STDLIB. These cases lock the wiring.
    it('seeds defaultGadgets onto never-registered apps on get()', async () => {
      const custom = [
        makeGadget({
          hook: 'useLeafletMap',
          package: '@ggui-samples/gadget-leaflet',
        }),
      ];
      const store = new InMemoryAppMetadataStore({
        defaultGadgets: custom,
      });
      const app = await store.get('never-registered');
      expect(app).not.toBeNull();
      expect(app?.gadgets).toBe(custom);
    });

    it('seeds defaultGadgets on register() when no per-app catalog passed', async () => {
      const custom = [
        makeGadget({
          hook: 'useLeafletMap',
          package: '@ggui-samples/gadget-leaflet',
        }),
      ];
      const store = new InMemoryAppMetadataStore({
        defaultGadgets: custom,
      });
      store.register('app-1');
      const app = await store.get('app-1');
      expect(app?.gadgets).toBe(custom);
    });

    it('per-app gadgets on register() wins over defaultGadgets', async () => {
      const defaultLibs = [
        makeGadget({ hook: 'useDefault', package: '@acme/default' }),
      ];
      const perAppLibs = [
        makeGadget({ hook: 'usePerApp', package: '@acme/per-app' }),
      ];
      const store = new InMemoryAppMetadataStore({
        defaultGadgets: defaultLibs,
      });
      store.register('app-1', { gadgets: perAppLibs });
      const app = await store.get('app-1');
      expect(app?.gadgets).toBe(perAppLibs);
    });

    // Slice 2 — public env channel wiring.
    it('seeds defaultPublicEnv onto never-registered apps on get()', async () => {
      const env = { GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' };
      const store = new InMemoryAppMetadataStore({ defaultPublicEnv: env });
      const app = await store.get('never-registered');
      expect(app).not.toBeNull();
      expect(app?.publicEnv).toEqual(env);
    });

    it('seeds defaultPublicEnv on register() when no per-app publicEnv passed', async () => {
      const env = { GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' };
      const store = new InMemoryAppMetadataStore({ defaultPublicEnv: env });
      store.register('app-1');
      const app = await store.get('app-1');
      expect(app?.publicEnv).toEqual(env);
    });

    it('per-app publicEnv on register() wins over defaultPublicEnv', async () => {
      const defaultEnv = { GGUI_PUBLIC_APP_DEFAULT: 'default' };
      const perAppEnv = { GGUI_PUBLIC_APP_PER_APP: 'per-app' };
      const store = new InMemoryAppMetadataStore({
        defaultPublicEnv: defaultEnv,
      });
      store.register('app-1', { publicEnv: perAppEnv });
      const app = await store.get('app-1');
      expect(app?.publicEnv).toEqual(perAppEnv);
    });

    it('App.publicEnv is absent when neither default nor per-app is set', async () => {
      const store = new InMemoryAppMetadataStore({
        defaultGadgets: [
          makeGadget({
            hook: 'useLeafletMap',
            package: '@ggui-samples/gadget-leaflet',
          }),
        ],
      });
      const app = await store.get('app-1');
      expect(app).not.toBeNull();
      expect(app?.publicEnv).toBeUndefined();
    });
  });

  describe('defaultDisplayMode (Slice B, 2026-05-17)', () => {
    it('is undefined on apps registered without the field', async () => {
      const store = new InMemoryAppMetadataStore();
      store.register('app-1');
      const app = await store.get('app-1');
      expect(app?.defaultDisplayMode).toBeUndefined();
    });

    it('preserves an explicit "fullscreen" setting', async () => {
      const store = new InMemoryAppMetadataStore();
      store.register('app-1', { defaultDisplayMode: 'fullscreen' });
      const app = await store.get('app-1');
      expect(app?.defaultDisplayMode).toBe('fullscreen');
    });

    it('preserves an explicit "inline" setting (still recorded, not stripped as no-op)', async () => {
      // Explicit 'inline' is meaningful — it documents the operator's
      // intent vs. an undefined-means-inline default. Keep it on the
      // record.
      const store = new InMemoryAppMetadataStore();
      store.register('app-1', { defaultDisplayMode: 'inline' });
      const app = await store.get('app-1');
      expect(app?.defaultDisplayMode).toBe('inline');
    });

    it('register() replaces the previous mode on re-register', async () => {
      const store = new InMemoryAppMetadataStore();
      store.register('app-1', { defaultDisplayMode: 'fullscreen' });
      store.register('app-1'); // re-register without the field
      const app = await store.get('app-1');
      // Re-register fully replaces — absent field ⇒ undefined.
      expect(app?.defaultDisplayMode).toBeUndefined();
    });
  });

  // Schema-hardening (Bucket A, 2026-05-18): store-write boundary
  // re-validates every gadget against `strictGadgetDescriptorSchema`.
  // Programmatic callers that hand a malformed entry now fail loudly
  // instead of silently riding through to render.
  describe('gadget validation at store boundary', () => {
    it('throws when register() input.gadgets is missing required teaching fields', () => {
      const store = new InMemoryAppMetadataStore();
      // GG.8.1 — a descriptor with no `exports[]` is malformed. The
      // store error now names the package identity, not a per-export
      // `hook` (which no longer lives at the descriptor level).
      const badGadget = {
        package: '@acme/x',
        version: '0.0.1',
      } as GadgetDescriptor;
      expect(() => store.register('app-1', { gadgets: [badGadget] })).toThrow(
        /gadget\[0\] \(@acme\/x@0\.0\.1, source=register-input\) failed schema validation/,
      );
    });

    it('throws at construction when defaultGadgets is malformed', () => {
      const badGadget = {} as GadgetDescriptor;
      expect(
        () => new InMemoryAppMetadataStore({ defaultGadgets: [badGadget] }),
      ).toThrow(/gadget\[0\] \(<missing-package>, source=register-defaults\)/);
    });

    it('accepts schema-valid gadgets via register()', async () => {
      const store = new InMemoryAppMetadataStore();
      const good = makeGadget({ hook: 'useGood', package: '@acme/good' });
      expect(() => store.register('app-1', { gadgets: [good] })).not.toThrow();
      const app = await store.get('app-1');
      expect(app?.gadgets).toEqual([good]);
    });
  });
});
