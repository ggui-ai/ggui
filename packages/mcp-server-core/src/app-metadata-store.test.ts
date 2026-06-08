// F1 (DRY foundation, 2026-05-17) — `composeApp` is the single source
// of truth for constructing an App from partial input. The 3 sites
// that used to hand-construct the App (InMemoryAppMetadataStore's
// register + get-fallback + the cloud `dynamoAppMetadataStore` adapter)
// all call this helper. These tests pin its semantics so the centralized
// composer's invariants (STDLIB fallback, absent-vs-empty distinction,
// empty-array convention for availableThemeIds) stay stable across
// refactors that touch the App interface.

import { describe, expect, it } from 'vitest';
import { STDLIB_GADGETS, type GadgetDescriptor } from '@ggui-ai/protocol';
import { composeApp, type AppGeneration } from './app-metadata-store.js';

describe('composeApp', () => {
  it('returns an App with STDLIB gadgets when gadgets is omitted', () => {
    const app = composeApp({ id: 'app-1' });
    expect(app.id).toBe('app-1');
    // Identity equality — composeApp reuses the stdlib reference
    // verbatim, never clones. Callers MUST treat it as readonly.
    expect(app.gadgets).toBe(STDLIB_GADGETS);
  });

  it('unions an explicit gadgets array with the stdlib floor', () => {
    // GG.8.1 — a `GadgetDescriptor` is a PACKAGE bundling `exports[]`.
    // resolveAppGadgets always includes the stdlib package as the floor,
    // so the result is a NEW array (union), not identity-equal to `custom`.
    const custom: GadgetDescriptor[] = [
      {
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [{ hook: 'useLeafletMap' }],
      },
    ];
    const app = composeApp({ id: 'app-1', gadgets: custom });
    // The stdlib package is always present as the floor.
    expect(app.gadgets.map((g) => g.package)).toEqual(
      expect.arrayContaining([STDLIB_GADGETS[0].package, '@ggui-samples/gadget-leaflet']),
    );
    expect(app.gadgets).toHaveLength(STDLIB_GADGETS.length + 1);
  });

  it('preserves the absent-vs-empty distinction for optional fields', () => {
    // Every optional field omitted ⇒ the resulting App has no such
    // field set (`'X' in app` is false). The OSS contract distinguishes
    // "operator said no" from "operator said empty" for downstream
    // gates (e.g., assertPublicEnvSatisfied treats absent + {} the same
    // semantically but the projection cares).
    const app = composeApp({ id: 'app-1' });
    expect('defaultThemeId' in app).toBe(false);
    expect('availableThemeIds' in app).toBe(false);
    expect('blueprintSearchConfig' in app).toBe(false);
    expect('publicEnv' in app).toBe(false);
    expect('generation' in app).toBe(false);
  });

  it('includes defaultThemeId when supplied', () => {
    const app = composeApp({ id: 'app-1', defaultThemeId: 'claudic' });
    expect(app.defaultThemeId).toBe('claudic');
  });

  it('includes availableThemeIds when supplied non-empty', () => {
    const app = composeApp({
      id: 'app-1',
      availableThemeIds: ['ggui', 'claudic'],
    });
    expect(app.availableThemeIds).toEqual(['ggui', 'claudic']);
  });

  it('treats an empty availableThemeIds array as absent (matches pre-extraction semantics)', () => {
    // Empty list = no filter, same as undefined. The pre-extraction
    // sites all used `availableThemeIds && length > 0` checks; the
    // composer preserves that convention.
    const app = composeApp({ id: 'app-1', availableThemeIds: [] });
    expect('availableThemeIds' in app).toBe(false);
  });

  it('includes blueprintSearchConfig when supplied', () => {
    const cfg = { threshold: 0.7, topK: 5 };
    const app = composeApp({ id: 'app-1', blueprintSearchConfig: cfg });
    expect(app.blueprintSearchConfig).toBe(cfg);
  });

  it('includes publicEnv when supplied (Slice 2)', () => {
    const env = { GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' };
    const app = composeApp({ id: 'app-1', publicEnv: env });
    expect(app.publicEnv).toBe(env);
  });

  it('includes publicEnv when supplied as an empty object', () => {
    // Empty publicEnv is distinguishable from absent — operator said
    // "I declared the field but stamped no values yet." The composer
    // forwards it verbatim; downstream filters decide what to do.
    const app = composeApp({ id: 'app-1', publicEnv: {} });
    expect('publicEnv' in app).toBe(true);
    expect(app.publicEnv).toEqual({});
  });

  it('keeps the stdlib package when an app declares an extension', () => {
    const ext = { ...STDLIB_GADGETS[0], package: '@acme/maps' };
    const app = composeApp({ id: 'a', gadgets: [ext] });
    expect(app.gadgets.map((g) => g.package)).toEqual(
      expect.arrayContaining([STDLIB_GADGETS[0].package, '@acme/maps']),
    );
  });

  // 2b M0.3 — generation read path
  it('passes generation through when supplied', () => {
    const generation: AppGeneration = {
      model: 'anthropic:claude-haiku-4-5-20251001',
      keySource: 'own',
    };
    const app = composeApp({ id: 'a', generation });
    expect(app.generation).toEqual(generation);
  });

  it('generation is absent when omitted (absent-vs-empty)', () => {
    const app = composeApp({ id: 'a' });
    expect('generation' in app).toBe(false);
  });

  // St3 M1 — theme read path
  it('composeApp threads theme through when present', () => {
    const theme = {
      mode: 'dark',
      cssVariables: { '--ggui-color-primary-600': '#7c3aed' },
    } as const;
    const app = composeApp({ id: 'a1', theme });
    expect(app.theme).toEqual(theme);
  });

  it('composeApp omits theme when absent', () => {
    expect(composeApp({ id: 'a1' }).theme).toBeUndefined();
  });

  it('round-trips a fully-populated App through the composer (drift canary)', () => {
    // If a new field is added to App but NOT to ComposeAppInput, this
    // round-trip will fail at compile time when the test fixture grows.
    // Acts as a drift canary for future App field additions.
    // `gadgets` is typed separately so its nested `exports[]` stays a
    // mutable `GadgetExport[]` — `as const` on the whole fixture would
    // freeze it to a readonly tuple, which `GadgetDescriptor` rejects.
    const fixtureGadgets: GadgetDescriptor[] = [
      {
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [{ hook: 'useLeafletMap' }],
      },
    ];
    const fixtureGeneration: AppGeneration = {
      model: 'anthropic:claude-haiku-4-5-20251001',
      keySource: 'managed',
    };
    const fixture = {
      id: 'app-1',
      gadgets: fixtureGadgets,
      defaultThemeId: 'claudic',
      availableThemeIds: ['claudic', 'ggui'],
      publicEnv: { GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' },
      generation: fixtureGeneration,
    } as const;
    const app = composeApp(fixture);
    expect(app.id).toBe(fixture.id);
    // resolveAppGadgets unions with stdlib floor — result is a new array,
    // not identity-equal to fixture.gadgets. The custom package is present.
    expect(app.gadgets.map((g) => g.package)).toEqual(
      expect.arrayContaining([STDLIB_GADGETS[0].package, fixtureGadgets[0].package]),
    );
    expect(app.gadgets).toHaveLength(STDLIB_GADGETS.length + 1);
    expect(app.defaultThemeId).toBe(fixture.defaultThemeId);
    expect(app.availableThemeIds).toEqual(fixture.availableThemeIds);
    expect(app.publicEnv).toBe(fixture.publicEnv);
    expect(app.generation).toEqual(fixtureGeneration);
  });
});
