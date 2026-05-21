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
import { composeApp } from './app-metadata-store.js';

describe('composeApp', () => {
  it('returns an App with STDLIB gadgets when gadgets is omitted', () => {
    const app = composeApp({ id: 'app-1' });
    expect(app.id).toBe('app-1');
    // Identity equality — composeApp reuses the stdlib reference
    // verbatim, never clones. Callers MUST treat it as readonly.
    expect(app.gadgets).toBe(STDLIB_GADGETS);
  });

  it('honors an explicit gadgets array verbatim', () => {
    // GG.8.1 — a `GadgetDescriptor` is a PACKAGE bundling `exports[]`.
    const custom: GadgetDescriptor[] = [
      {
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [{ hook: 'useLeafletMap' }],
      },
    ];
    const app = composeApp({ id: 'app-1', gadgets: custom });
    // Identity preserved through the composer.
    expect(app.gadgets).toBe(custom);
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
    const fixture = {
      id: 'app-1',
      gadgets: fixtureGadgets,
      defaultThemeId: 'claudic',
      availableThemeIds: ['claudic', 'ggui'],
      publicEnv: { GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' },
    } as const;
    const app = composeApp(fixture);
    expect(app.id).toBe(fixture.id);
    expect(app.gadgets).toBe(fixture.gadgets);
    expect(app.defaultThemeId).toBe(fixture.defaultThemeId);
    expect(app.availableThemeIds).toEqual(fixture.availableThemeIds);
    expect(app.publicEnv).toBe(fixture.publicEnv);
  });
});
