import { describe, it, expect } from 'vitest';
import type {
  ActionSpec,
  ContextSpec,
  GadgetDescriptor,
  JsonObject,
  StreamSpec,
} from '@ggui-ai/protocol';
import type { StackItem, SystemStackItem } from '@ggui-ai/protocol';
import {
  composeContentSecurityPolicy,
  deriveBundleOrigins,
  deriveGadgetRegistrations,
  resolveGadgetUrls,
  deriveContextSlots,
  derivePermissionsPolicy,
  derivePropsJson,
  derivePublicEnvProjection,
  deriveStackItemMeta,
  deriveWiredActionTools,
} from './slice-meta-derivation';

const NOW = '2026-05-09T00:00:00.000Z';

function componentItem(over: Partial<StackItem> = {}): StackItem {
  return {
    id: 'page-1',
    type: 'component',
    componentCode: 'export default () => null;',
    createdAt: NOW,
    ...over,
  };
}

function systemItem(over: Partial<SystemStackItem> = {}): SystemStackItem {
  return {
    id: 'page-1',
    type: 'system',
    kind: 'no-credentials',
    createdAt: NOW,
    ...over,
  };
}

/**
 * GG.8.1 — a `GadgetDescriptor` is now a PACKAGE bundling one or more
 * `exports[]`. The derivation helpers all walk `gadgetDescriptors`
 * (the resolved descriptor sidecar). This factory builds a one-hook
 * package descriptor from flat fields: `hook` + `permission` are
 * per-EXPORT; everything else (`package` / `version` / `bundleUrl` /
 * `bundleHost` / `bundleSri` / `styleUrl` / `connect` / `requires`) is
 * per-PACKAGE.
 */
function gpkg(fields: {
  hook: string;
  package: string;
  version: string;
  permission?: string;
  bundleUrl?: string;
  bundleHost?: string;
  bundleSri?: string;
  styleUrl?: string;
  connect?: readonly string[];
  requires?: readonly string[];
}): GadgetDescriptor {
  const {
    hook,
    permission,
    package: pkg,
    version,
    ...packageTransport
  } = fields;
  return {
    package: pkg,
    version,
    exports: [
      {
        hook,
        ...(permission !== undefined ? { permission } : {}),
      },
    ],
    ...packageTransport,
  };
}

describe('derivePropsJson', () => {
  it('returns undefined when item has no props', () => {
    expect(derivePropsJson(componentItem())).toBeUndefined();
  });

  it('returns the JSON-stringified value when props is a flat object', () => {
    const item = componentItem({ props: { city: 'Seoul', temperature: 12 } });
    expect(derivePropsJson(item)).toBe('{"city":"Seoul","temperature":12}');
  });

  it('returns the JSON-stringified value when props is nested', () => {
    const item = componentItem({
      props: { highTemp: { celsius: 26, fahrenheit: 79 } },
    });
    expect(derivePropsJson(item)).toBe(
      '{"highTemp":{"celsius":26,"fahrenheit":79}}',
    );
  });

  it('handles empty object props', () => {
    const item = componentItem({ props: {} });
    expect(derivePropsJson(item)).toBe('{}');
  });

  it('returns undefined on serialization failure (defensive — circular ref)', () => {
    // The propsSpec validator upstream of push won't admit a circular
    // value, but the serializer should still degrade gracefully if
    // one slips through (e.g. a mutation post-validation). Cast
    // forces the test off the JsonObject contract intentionally.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const item = componentItem({ props: circular as JsonObject });
    expect(derivePropsJson(item)).toBeUndefined();
  });

  it('also projects props on system-card items', () => {
    const item = systemItem({ props: { reason: 'demo' } });
    expect(derivePropsJson(item)).toBe('{"reason":"demo"}');
  });
});

describe('deriveStackItemMeta', () => {
  // T3-1 (2026-05-13) — the projection no longer carries componentCode.
  // Static-component bytes ride on the push handler's `codeUrl` channel
  // composed from its `codeStore` + `codeBaseUrl` deps. The view now
  // emits only the wire-shape metadata fields (propsJson, actionNextSteps,
  // contextSlots, permissionsPolicy) plus the `kind` discriminator for
  // system variants.

  it('component variant: omits componentCode (delivered via codeUrl channel)', () => {
    const view = deriveStackItemMeta(componentItem());
    expect((view as Record<string, unknown>).componentCode).toBeUndefined();
    expect(view.kind).toBeUndefined();
  });

  it('component variant: includes propsJson when props are present', () => {
    const view = deriveStackItemMeta(
      componentItem({ props: { city: 'Seoul' } }),
    );
    expect(view.propsJson).toBe('{"city":"Seoul"}');
  });

  it("component variant: includes actionNextSteps when actionSpec declares dispatch.kind='tool' entries", () => {
    const actionSpec: ActionSpec = {
      save: { label: 'Save', nextStep: 'save_note' },
      undo: { label: 'Undo' },
    };
    const view = deriveStackItemMeta(componentItem({ actionSpec }));
    // `save` has dispatch.kind='tool' → included. `undo` is agent-routed → excluded.
    expect(view.actionNextSteps).toEqual({ save: 'save_note' });
  });

  it('component variant: includes contextSlots when contextSpec is declared', () => {
    const contextSpec: ContextSpec = {
      count: { schema: { type: 'number' }, default: 0 },
    };
    const view = deriveStackItemMeta(componentItem({ contextSpec }));
    expect(view.contextSlots).toBeDefined();
    expect(view.contextSlots?.[0]?.name).toBe('count');
    expect(view.contextSlots?.[0]?.default).toBe(0);
  });

  it('component variant: streamSpec does not leak into the View (declared in contract, not bootstrap)', () => {
    const streamSpec: StreamSpec = {
      ticks: { schema: { type: 'object' } },
    };
    const view = deriveStackItemMeta(componentItem({ streamSpec }));
    // No streamSpec field on the View today. If a future field is
    // added, update both the View interface AND this assertion.
    expect((view as Record<string, unknown>).streamSpec).toBeUndefined();
  });

  it('system variant: emits kind + propsJson', () => {
    const view = deriveStackItemMeta(
      systemItem({ kind: 'no-credentials', props: { reason: 'demo' } }),
    );
    expect(view.kind).toBe('no-credentials');
    expect(view.propsJson).toBe('{"reason":"demo"}');
    expect((view as Record<string, unknown>).componentCode).toBeUndefined();
    expect(view.actionNextSteps).toBeUndefined();
    expect(view.contextSlots).toBeUndefined();
  });

  it('system variant: omits kind when empty string', () => {
    const view = deriveStackItemMeta(systemItem({ kind: '' }));
    expect(view.kind).toBeUndefined();
  });

  it('mcpApps variant: returns empty View (separate shell wiring)', () => {
    const view = deriveStackItemMeta({
      id: 'page-1',
      type: 'mcpApps',
      source: {
        connectorId: 'example',
        toolName: 'open_x',
        resourceUri: 'ui://example/x',
      },
      createdAt: NOW,
    });
    expect(view).toEqual({});
  });

  it('full component view: every field populated', () => {
    const view = deriveStackItemMeta(
      componentItem({
        props: { city: 'Seoul' },
        actionSpec: { save: { label: 'Save', nextStep: 'save_note' } },
        contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
      }),
    );
    expect(view).toEqual({
      propsJson: '{"city":"Seoul"}',
      actionNextSteps: { save: 'save_note' },
      contextSlots: [
        {
          name: 'count',
          contextName: 'CountContext',
          schema: { type: 'number' },
          default: 0,
        },
      ],
      // Validators are no longer projected onto the view — push.ts
      // calls deriveContractBundle directly + writes to the
      // content-addressable store. The view carries no contract bytes.
    });
  });
});

describe('deriveContractBundle — content-addressable validator bundle', () => {
  it('component variant: returns {contractHash, bundleSource, validators}', async () => {
    const { deriveContractBundle } = await import('./slice-meta-derivation.js');
    const bundle = await deriveContractBundle(
      componentItem({
        propsSpec: {
          properties: { city: { schema: { type: 'string' }, required: true } },
        },
        actionSpec: {
          rename: { label: 'Rename', schema: { type: 'object', properties: { to: { type: 'string' } } } },
        },
        streamSpec: { ticks: { schema: { type: 'object' } } },
        contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
      }),
    );
    expect(bundle).toBeDefined();
    if (!bundle) return;
    expect(bundle.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.bundleSource).toContain('export default');
    expect(typeof bundle.validators.props).toBe('string');
    expect(typeof bundle.validators.actions?.rename).toBe('string');
    expect(typeof bundle.validators.streams?.ticks).toBe('string');
    expect(typeof bundle.validators.context?.count).toBe('string');
  });

  it('mcpApps / system variants return undefined', async () => {
    const { deriveContractBundle } = await import('./slice-meta-derivation.js');
    expect(
      await deriveContractBundle(systemItem({ kind: 'no-credentials' })),
    ).toBeUndefined();
    expect(
      await deriveContractBundle({
        id: 'page-1',
        type: 'mcpApps',
        source: {
          connectorId: 'example',
          toolName: 'open_x',
          resourceUri: 'ui://example/x',
        },
        createdAt: NOW,
      }),
    ).toBeUndefined();
  });
});

describe('deriveContextSlots — resume-aware seed from contextSnapshot', () => {
  // Resume contract — slice V wires the runtime to mirror its
  // contextSpec snapshots to the server via `ggui_runtime_sync_context`.
  // The handler upserts onto `StackItem.contextSnapshot`. On
  // chat-history rehydrate, the bootstrap-meta projection reads the
  // snapshot first (when present) and falls back to the contract's
  // authoring-time default when a slot wasn't covered. The user
  // sees their last-known interactive state instead of a reset.
  it('seeds contextSlots[i].default from contextSnapshot when present', () => {
    const item = componentItem({
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
        noteText: { schema: { type: 'string' }, default: '' },
      },
      contextSnapshot: { count: 5, noteText: 'unsaved draft' },
    });
    const slots = deriveContextSlots(item);
    expect(slots).toBeDefined();
    expect(slots).toEqual([
      {
        name: 'count',
        contextName: 'CountContext',
        schema: { type: 'number' },
        default: 5,
      },
      {
        name: 'noteText',
        contextName: 'NoteTextContext',
        schema: { type: 'string' },
        default: 'unsaved draft',
      },
    ]);
  });

  it('partial snapshot: snapshotted slots use snapshot, others use contract default', () => {
    const item = componentItem({
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
        noteText: { schema: { type: 'string' }, default: '' },
      },
      // Snapshot only carries `count`. `noteText` falls back to
      // the contract default.
      contextSnapshot: { count: 7 },
    });
    const slots = deriveContextSlots(item);
    expect(slots?.[0]).toMatchObject({ name: 'count', default: 7 });
    expect(slots?.[1]).toMatchObject({ name: 'noteText', default: '' });
  });

  it('no snapshot: slots use contract default (slice V backwards-compat)', () => {
    const item = componentItem({
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
      },
    });
    const slots = deriveContextSlots(item);
    expect(slots?.[0]).toMatchObject({ name: 'count', default: 0 });
  });

  it('snapshot with literal null preserves the null (not coerced to default)', () => {
    const item = componentItem({
      contextSpec: {
        nullable: { schema: { type: 'string' }, default: 'fallback' },
      },
      // Snapshot explicitly sets null. Some slots are nullable; the
      // user may have cleared the field. Don't fall through to
      // default just because the value is "falsy".
      contextSnapshot: { nullable: null },
    });
    const slots = deriveContextSlots(item);
    expect(slots?.[0]).toMatchObject({ name: 'nullable', default: null });
  });
});

describe('deriveWiredActionTools / deriveContextSlots — single-purpose helpers', () => {
  // Existing helpers retained for callers that only need one field;
  // the unified View is the preferred entry point but these stay
  // public so legacy code paths can migrate piecemeal.
  it('deriveWiredActionTools returns undefined when no actionSpec', () => {
    expect(deriveWiredActionTools(componentItem())).toBeUndefined();
  });

  it('deriveContextSlots returns undefined when no contextSpec', () => {
    expect(deriveContextSlots(componentItem())).toBeUndefined();
  });
});

describe('derivePermissionsPolicy — clientCapabilities → Permissions-Policy directives', () => {
  // Phase 4.3 (2026-05-12) — the bootstrap derivation reads
  // `contract.clientCapabilities.gadgets[*].permission` and emits a
  // union-deduplicated directive set. Replaces the retired pre-EE+
  // `App.declaredAdapters` runtime gate (Phase 2.1).

  it('returns undefined when clientCapabilities is absent', () => {
    expect(derivePermissionsPolicy(componentItem())).toBeUndefined();
  });

  it('returns undefined when libraries map is empty', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [];
    expect(
      derivePermissionsPolicy(componentItem({ gadgetDescriptors })),
    ).toBeUndefined();
  });

  it('returns undefined when no entries declare `permission`', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useFilePicker',
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
      }),
    ];
    expect(
      derivePermissionsPolicy(componentItem({ gadgetDescriptors })),
    ).toBeUndefined();
  });

  it('unions every declared permission in declaration order', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useCamera',
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        permission: 'camera',
      }),
      gpkg({
        hook: 'useMicrophone',
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        permission: 'microphone',
      }),
      gpkg({
        hook: 'useGeolocation',
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        permission: 'geolocation',
      }),
    ];
    expect(derivePermissionsPolicy(componentItem({ gadgetDescriptors }))).toEqual([
      'camera',
      'microphone',
      'geolocation',
    ]);
  });

  it('deduplicates repeated permission values', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useClipboardWrite',
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        permission: 'clipboard-write',
      }),
      gpkg({
        hook: 'useCopyToken',
        package: '@acme/tokens',
        version: '0.0.1',
        permission: 'clipboard-write',
      }),
    ];
    expect(derivePermissionsPolicy(componentItem({ gadgetDescriptors }))).toEqual([
      'clipboard-write',
    ]);
  });

  it('skips entries with empty-string permission', () => {
    // Empty-string permission is structurally valid for the type but
    // semantically empty — derive should skip it.
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useCamera',
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        permission: 'camera',
      }),
      gpkg({
        hook: 'useX',
        package: '@acme/x',
        version: '0.0.1',
        permission: '',
      }),
    ];
    expect(
      derivePermissionsPolicy(componentItem({ gadgetDescriptors })),
    ).toEqual(['camera']);
  });

  it('system items return undefined (no clientCapabilities field on SystemStackItem)', () => {
    expect(derivePermissionsPolicy(systemItem())).toBeUndefined();
  });

  it('mcpApps items return undefined', () => {
    expect(
      derivePermissionsPolicy({
        id: 'page-1',
        type: 'mcpApps',
        source: {
          connectorId: 'example',
          toolName: 'open_x',
          resourceUri: 'ui://example/x',
        },
        createdAt: NOW,
      }),
    ).toBeUndefined();
  });
});

describe('deriveStackItemMeta — permissionsPolicy projection', () => {
  // Single-entry-point projection. When clientCapabilities declares
  // permissions, the View MUST surface them so every transport
  // (public-render header, MCP Apps _meta, inline bootstrap) reads from
  // the same source of truth.
  it('component variant: includes permissionsPolicy when clientCapabilities declares permissions', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useMicrophone',
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        permission: 'microphone',
      }),
    ];
    const view = deriveStackItemMeta(
      componentItem({ gadgetDescriptors }),
    );
    expect(view.permissionsPolicy).toEqual(['microphone']);
  });

  it('component variant: omits permissionsPolicy when libraries declare no permissions', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useFilePicker',
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
      }),
    ];
    const view = deriveStackItemMeta(
      componentItem({ gadgetDescriptors }),
    );
    expect(view.permissionsPolicy).toBeUndefined();
  });
});

describe('deriveBundleOrigins — bundleUrl/styleUrl/connect → CSP origins (plugin slice Commit 5)', () => {
  it('returns undefined when no clientCapabilities are declared', () => {
    expect(deriveBundleOrigins(componentItem())).toBeUndefined();
  });

  it('returns undefined when libraries declare no external origins', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useGeolocation',
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
      }),
    ];
    expect(
      deriveBundleOrigins(componentItem({ gadgetDescriptors })),
    ).toBeUndefined();
  });

  it('collects bundleUrl origins into script[]', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useLeafletMap',
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        bundleUrl: 'https://bundles.example.com/leaflet@1.0/bundle.js',
      }),
    ];
    const origins = deriveBundleOrigins(componentItem({ gadgetDescriptors }));
    expect(origins?.script).toEqual(['https://bundles.example.com']);
    expect(origins?.style).toEqual([]);
    expect(origins?.connect).toEqual([]);
  });

  it('collects styleUrl origins into style[] and connect[] origins separately', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useLeafletMap',
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        bundleUrl: 'https://bundles.example.com/leaflet@1.0/bundle.js',
        styleUrl: 'https://bundles.example.com/leaflet@1.0/leaflet.css',
        connect: ['https://tile.openstreetmap.org'],
      }),
    ];
    const origins = deriveBundleOrigins(componentItem({ gadgetDescriptors }));
    expect(origins?.script).toEqual(['https://bundles.example.com']);
    expect(origins?.style).toEqual(['https://bundles.example.com']);
    expect(origins?.connect).toEqual(['https://tile.openstreetmap.org']);
  });

  it('deduplicates same-origin URLs per bucket', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useA',
        package: '@acme/a',
        version: '0.0.1',
        bundleUrl: 'https://bundles.example.com/a@1/x.js',
        connect: ['https://api.example.com/v1', 'https://api.example.com/v2'],
      }),
      gpkg({
        hook: 'useB',
        package: '@acme/b',
        version: '0.0.1',
        bundleUrl: 'https://bundles.example.com/b@1/x.js',
      }),
    ];
    const origins = deriveBundleOrigins(componentItem({ gadgetDescriptors }));
    expect(origins?.script).toEqual(['https://bundles.example.com']);
    expect(origins?.connect).toEqual(['https://api.example.com']);
  });

  it('drops malformed URLs silently (defensive)', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useBad',
        package: '@acme/bad',
        version: '0.0.1',
        bundleUrl: 'not-a-url',
        connect: ['also-bad', 'https://valid.example.com'],
      }),
    ];
    const origins = deriveBundleOrigins(componentItem({ gadgetDescriptors }));
    expect(origins?.script).toEqual([]);
    expect(origins?.connect).toEqual(['https://valid.example.com']);
  });

  it('resolves bundleHost-driven URLs into the CSP origin allowlist', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useLeafletMap',
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        bundleHost: 'sandbox-ggui-main.registry.sandbox.ggui.ai',
        connect: ['https://tile.openstreetmap.org'],
      }),
    ];
    const origins = deriveBundleOrigins(componentItem({ gadgetDescriptors }));
    expect(origins?.script).toEqual([
      'https://sandbox-ggui-main.registry.sandbox.ggui.ai',
    ]);
    expect(origins?.style).toEqual([
      'https://sandbox-ggui-main.registry.sandbox.ggui.ai',
    ]);
    expect(origins?.connect).toEqual(['https://tile.openstreetmap.org']);
  });

  it('falls back to spec-default bundleHost when entry omits it', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useLeafletMap',
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        // No bundleHost — server should compute against registry.ggui.ai.
      }),
    ];
    const origins = deriveBundleOrigins(componentItem({ gadgetDescriptors }));
    expect(origins?.script).toEqual(['https://registry.ggui.ai']);
    expect(origins?.style).toEqual(['https://registry.ggui.ai']);
  });

  it('explicit bundleUrl wins over bundleHost (escape-hatch precedence)', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useLeafletMap',
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        // Operator's full-URL override wins over hostname resolution.
        bundleUrl: 'https://esm.sh/leaflet/dist/leaflet.js',
        bundleHost: 'sandbox-ggui-main.registry.sandbox.ggui.ai',
      }),
    ];
    const origins = deriveBundleOrigins(componentItem({ gadgetDescriptors }));
    expect(origins?.script).toEqual(['https://esm.sh']);
  });

  // Note (Slice GG.6 migration): the original "skips bundleHost
  // resolution when package or version is missing" case is no longer
  // expressible — `GadgetDescriptor.package` and `.version` are now
  // REQUIRED, so the prior scenario (missing trio) cannot be constructed
  // without type erasure. The behaviour is now covered by the
  // `resolveGadgetUrls` direct unit ("returns nothing when bundleHost is
  // present but package+version missing") which uses `as never` against
  // the resolver's narrower Pick<> signature.
});

describe('resolveGadgetUrls — bundleHost / bundleUrl / styleUrl precedence', () => {
  it('returns nothing when entry has neither bundleUrl nor a resolvable bundleHost', () => {
    expect(resolveGadgetUrls({ hook: 'useStdlib' } as never)).toEqual({});
  });

  it('passes through explicit bundleUrl + styleUrl verbatim (escape hatch)', () => {
    const out = resolveGadgetUrls({
      bundleUrl: 'https://esm.sh/leaflet/dist/leaflet.js',
      styleUrl: 'https://esm.sh/leaflet/dist/leaflet.css',
    } as never);
    expect(out.bundleUrl).toBe('https://esm.sh/leaflet/dist/leaflet.js');
    expect(out.styleUrl).toBe('https://esm.sh/leaflet/dist/leaflet.css');
  });

  it('computes URLs from bundleHost + package + version', () => {
    const out = resolveGadgetUrls({
      package: '@ggui-samples/gadget-leaflet',
      version: '0.0.1',
      bundleHost: 'sandbox.registry.ggui.ai',
    } as never);
    expect(out.bundleUrl).toBe(
      'https://sandbox.registry.ggui.ai/bundles/@ggui-samples/gadget-leaflet/0.0.1/bundle.js',
    );
    expect(out.styleUrl).toBe(
      'https://sandbox.registry.ggui.ai/bundles/@ggui-samples/gadget-leaflet/0.0.1/style.css',
    );
  });

  it('falls back to spec-default bundleHost when none declared', () => {
    const out = resolveGadgetUrls({
      package: '@ggui-samples/gadget-leaflet',
      version: '0.0.1',
    } as never);
    expect(out.bundleUrl).toBe(
      'https://registry.ggui.ai/bundles/@ggui-samples/gadget-leaflet/0.0.1/bundle.js',
    );
  });

  it('bundleUrl beats bundleHost (operator override wins)', () => {
    const out = resolveGadgetUrls({
      package: '@ggui-samples/gadget-leaflet',
      version: '0.0.1',
      bundleHost: 'sandbox.registry.ggui.ai',
      bundleUrl: 'https://my-cdn.example/leaflet.js',
    } as never);
    expect(out.bundleUrl).toBe('https://my-cdn.example/leaflet.js');
  });

  it('styleUrl beats bundleHost for the style channel independently', () => {
    const out = resolveGadgetUrls({
      package: '@ggui-samples/gadget-leaflet',
      version: '0.0.1',
      bundleHost: 'sandbox.registry.ggui.ai',
      styleUrl: 'https://my-cdn.example/leaflet.css',
    } as never);
    // bundle still computes from bundleHost; style takes the override.
    expect(out.bundleUrl).toBe(
      'https://sandbox.registry.ggui.ai/bundles/@ggui-samples/gadget-leaflet/0.0.1/bundle.js',
    );
    expect(out.styleUrl).toBe('https://my-cdn.example/leaflet.css');
  });

  it('returns nothing when bundleHost is present but package+version missing', () => {
    expect(
      resolveGadgetUrls({ bundleHost: 'registry.ggui.ai' } as never),
    ).toEqual({});
  });

  // Loopback hosts → http:// (mirror of buildInstallCommand in
  // @ggui-ai/registry-core). Pre-launch invariant: install + render
  // emit the same scheme for the same host.
  it.each([
    'localhost',
    'localhost:8787',
    '127.0.0.1',
    '127.0.0.1:9001',
    '0.0.0.0',
    '0.0.0.0:6783',
  ])('uses http:// for loopback host %s', (host) => {
    const out = resolveGadgetUrls({
      package: '@ggui-samples/gadget-leaflet',
      version: '0.0.1',
      bundleHost: host,
    } as never);
    expect(out.bundleUrl).toBe(
      `http://${host}/bundles/@ggui-samples/gadget-leaflet/0.0.1/bundle.js`,
    );
    expect(out.styleUrl).toBe(
      `http://${host}/bundles/@ggui-samples/gadget-leaflet/0.0.1/style.css`,
    );
  });

  it('does NOT treat lookalike non-loopback hostnames as loopback', () => {
    // `localhost-evil.example.com` and `127.0.0.1.evil.example.com`
    // both start with the loopback substring; the anchored regex
    // rejects them so render keeps `https://`.
    const out = resolveGadgetUrls({
      package: '@ggui-samples/gadget-leaflet',
      version: '0.0.1',
      bundleHost: 'localhost-evil.example.com',
    } as never);
    expect(out.bundleUrl).toBe(
      'https://localhost-evil.example.com/bundles/@ggui-samples/gadget-leaflet/0.0.1/bundle.js',
    );
  });
});

describe('composeContentSecurityPolicy', () => {
  it('returns undefined when no origins are declared', () => {
    expect(composeContentSecurityPolicy(undefined)).toBeUndefined();
  });

  it('composes a directive list pinning self alongside declared origins', () => {
    const csp = composeContentSecurityPolicy({
      script: ['https://bundles.example.com'],
      style: ['https://bundles.example.com'],
      connect: ['https://tile.openstreetmap.org'],
    });
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' https://bundles.example.com",
    );
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://bundles.example.com");
    expect(csp).toContain("connect-src 'self' https://tile.openstreetmap.org");
  });

  it('omits directives whose bucket is empty', () => {
    const csp = composeContentSecurityPolicy({
      script: ['https://bundles.example.com'],
      style: [],
      connect: [],
    });
    expect(csp).toBe(
      "script-src 'self' 'unsafe-inline' https://bundles.example.com",
    );
  });

  // Bug #1 (Slice 1.1) — the inline `<script>__GGUI_META__ = …</script>`
  // tag the renderer embeds on `/r/<shortCode>` requires
  // `'unsafe-inline'` in `script-src`. Without it, declaring any
  // `bundleUrl` would crash the iframe boot the moment a CSP header
  // gets attached. Pin this in a regression test so any future
  // tightening of the directive (e.g. nonce-based scripts) lands
  // intentionally.
  it("includes 'unsafe-inline' in script-src so the inline bootstrap loads", () => {
    const csp = composeContentSecurityPolicy({
      script: ['https://bundles.example.com'],
      style: [],
      connect: [],
    });
    expect(csp).toMatch(/script-src [^;]*'unsafe-inline'/);
  });

  // Bug #2 (Slice 1.1) — `connect-src` covers fetch/XHR/WebSocket but
  // NOT `<img src=>`. Map plugins (Leaflet, Mapbox) load tiles via
  // `<img>` from a tile-server origin. The composer derives `img-src`
  // from `connect[]` so plugin authors don't have to redeclare the
  // same CDN twice.
  it('emits img-src derived from connect[] origins (and data:)', () => {
    const csp = composeContentSecurityPolicy({
      script: [],
      style: [],
      connect: ['https://tile.openstreetmap.org'],
    });
    expect(csp).toContain(
      "img-src 'self' data: https://tile.openstreetmap.org",
    );
  });

  it('omits img-src when connect bucket is empty (no implicit img-src)', () => {
    const csp = composeContentSecurityPolicy({
      script: ['https://bundles.example.com'],
      style: [],
      connect: [],
    });
    expect(csp).not.toMatch(/img-src/);
  });
});

// Slice 3.9 — `bundleSri` threading. Registry-published wrappers
// carry a SHA-384 SRI hash; the bootstrap projection must surface
// it verbatim so the iframe-runtime emits a `<link integrity>`. A
// stray SRI on a package-only ref is dropped (SRI requires a URL).
describe('deriveGadgetRegistrations — Slice 3.9 bundleSri threading', () => {
  it('threads bundleSri through when paired with bundleUrl', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useMapbox',
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
        bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
      }),
    ];
    const regs = deriveGadgetRegistrations(
      componentItem({ gadgetDescriptors }),
    );
    expect(regs).toEqual([
      {
        package: '@ggui-samples/gadget-mapbox',
        bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
        bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
      },
    ]);
  });

  it('preserves bundleSri when bundleUrl is resolved from bundleHost (Slice GG.6: descriptors always have package+version, so resolution succeeds)', () => {
    // Original "drops bundleSri on a package-only ref" no longer applies
    // post-GG.6 — every `GadgetDescriptor` carries `package` + `version`,
    // so `resolveGadgetUrls` always returns a `bundleUrl` and the SRI is
    // paired with it. The pre-GG.6 "package-only ref" shape isn't
    // constructible without type erasure (banned by CLAUDE.md). The
    // sri-drop branch (`bundleStr === undefined`) remains in the impl
    // but is now unreachable from a typed descriptor — kept defensive.
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useMapbox',
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
      }),
    ];
    const regs = deriveGadgetRegistrations(
      componentItem({ gadgetDescriptors }),
    );
    expect(regs).toEqual([
      {
        package: '@ggui-samples/gadget-mapbox',
        bundleUrl: 'https://registry.ggui.ai/bundles/@ggui-samples/gadget-mapbox/0.0.1/bundle.js',
        bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
      },
    ]);
  });

  it('omits bundleSri when absent (back-compat / pre-3.9 refs)', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useMapbox',
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
      }),
    ];
    const regs = deriveGadgetRegistrations(
      componentItem({ gadgetDescriptors }),
    );
    expect(regs).toEqual([
      {
        package: '@ggui-samples/gadget-mapbox',
        bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
      },
    ]);
  });
});

describe('deriveStackItemMeta — contentSecurityPolicy projection', () => {
  it('attaches contentSecurityPolicy when libraries declare external origins', () => {
    const gadgetDescriptors: readonly GadgetDescriptor[] = [
      gpkg({
        hook: 'useLeafletMap',
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        bundleUrl: 'https://bundles.example.com/leaflet@1.0/bundle.js',
      }),
    ];
    const view = deriveStackItemMeta(
      componentItem({ gadgetDescriptors }),
    );
    expect(view.contentSecurityPolicy).toContain(
      "script-src 'self' 'unsafe-inline' https://bundles.example.com",
    );
  });

  it('omits contentSecurityPolicy when libraries declare no external origins (regression for 8/16/17/18)', () => {
    const view = deriveStackItemMeta(componentItem());
    expect(view.contentSecurityPolicy).toBeUndefined();
  });
});

// Slice 2.2 — projection helper for the public env channel. Takes
// the stack item (for declared wrappers' `requires`) and the App's
// publicEnv map (for values); emits the union-filtered subset.
describe('derivePublicEnvProjection', () => {
  function mapboxRef(): GadgetDescriptor {
    return gpkg({
      hook: 'useMapbox',
      package: '@ggui-samples/gadget-mapbox',
      version: '0.0.1',
      requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN'],
    });
  }

  function stripeRef(): GadgetDescriptor {
    return gpkg({
      hook: 'useStripeCheckout',
      package: '@ggui-samples/wrapper-stripe',
      version: '0.0.1',
      requires: ['GGUI_PUBLIC_APP_STRIPE_KEY'],
    });
  }

  function leafletRef(): GadgetDescriptor {
    return gpkg({
      hook: 'useLeafletMap',
      package: '@ggui-samples/gadget-leaflet',
      version: '0.0.1',
      // No requires.
    });
  }

  function componentWithCaps(
    gadgetDescriptors: readonly GadgetDescriptor[],
  ): StackItem {
    return componentItem({ gadgetDescriptors });
  }

  it('returns undefined when the item has no clientCapabilities', () => {
    expect(
      derivePublicEnvProjection(componentItem(), {
        GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'tok',
      }),
    ).toBeUndefined();
  });

  it('returns undefined when no declared wrapper has requires', () => {
    const item = componentWithCaps([leafletRef()]);
    expect(
      derivePublicEnvProjection(item, {
        GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'tok',
      }),
    ).toBeUndefined();
  });

  it('returns undefined when appPublicEnv is undefined despite requires (push gate caught it upstream)', () => {
    const item = componentWithCaps([mapboxRef()]);
    expect(derivePublicEnvProjection(item, undefined)).toBeUndefined();
  });

  it('emits the filtered subset for a single-wrapper contract', () => {
    const item = componentWithCaps([mapboxRef()]);
    expect(
      derivePublicEnvProjection(item, {
        GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
        GGUI_PUBLIC_APP_UNRELATED: 'value',
      }),
    ).toEqual({ GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' });
  });

  it('emits the union across multiple wrappers', () => {
    const item = componentWithCaps([mapboxRef(), stripeRef()]);
    expect(
      derivePublicEnvProjection(item, {
        GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
        GGUI_PUBLIC_APP_STRIPE_KEY: 'pk_test_...',
        GGUI_PUBLIC_APP_UNUSED: 'leaked-if-emitted',
      }),
    ).toEqual({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
      GGUI_PUBLIC_APP_STRIPE_KEY: 'pk_test_...',
    });
  });

  it('drops App.publicEnv keys no declared wrapper asked for (minimum-disclosure)', () => {
    const item = componentWithCaps([mapboxRef()]);
    const projected = derivePublicEnvProjection(item, {
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
      GGUI_PUBLIC_APP_STRIPE_KEY: 'pk_test_...',
      GGUI_PUBLIC_APP_DOORDASH: 'dd_...',
    });
    expect(projected).toBeDefined();
    expect(Object.keys(projected ?? {})).toEqual([
      'GGUI_PUBLIC_APP_MAPBOX_TOKEN',
    ]);
  });

  it('mixed wrapper set — only the ones with requires contribute', () => {
    const item = componentWithCaps([
      leafletRef(), // no requires — contributes nothing
      stripeRef(), // contributes
    ]);
    expect(
      derivePublicEnvProjection(item, {
        GGUI_PUBLIC_APP_STRIPE_KEY: 'pk_test_...',
      }),
    ).toEqual({ GGUI_PUBLIC_APP_STRIPE_KEY: 'pk_test_...' });
  });

  it('returns undefined when filtered map is empty (requires unsatisfied by App)', () => {
    // The push gate should reject this case upstream; if reached, the
    // projection emits nothing rather than risk a half-populated map.
    const item = componentWithCaps([mapboxRef()]);
    expect(
      derivePublicEnvProjection(item, {
        GGUI_PUBLIC_APP_UNRELATED: 'value',
      }),
    ).toBeUndefined();
  });

  // Slice GG.6 migration note: the original "skips non-object library
  // refs defensively" test relied on `clientCapabilities.gadgets[k] =
  // null` (record-of-anything wire shape). Post-GG.6 the deriver reads
  // `gadgetDescriptors`, a `readonly GadgetDescriptor[]` — non-object
  // entries cannot be constructed without type erasure (banned by
  // CLAUDE.md). The defensive `if (!Array.isArray(ref.requires))
  // continue;` branch in the impl remains in place; this test is
  // dropped because the scenario is structurally impossible to express.

  it('handles non-string requires entries defensively', () => {
    const item = componentWithCaps([
      gpkg({
        hook: 'useMapbox',
        package: '@x/y',
        version: '0.0.1',
        requires: [
          'GGUI_PUBLIC_APP_MAPBOX_TOKEN',
          123 as unknown as string,
          '',
        ],
      }),
    ]);
    // Only the valid key contributes.
    expect(
      derivePublicEnvProjection(item, {
        GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk',
      }),
    ).toEqual({ GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk' });
  });

  it('skips non-string App.publicEnv values defensively', () => {
    const item = componentWithCaps([mapboxRef()]);
    expect(
      derivePublicEnvProjection(item, {
        GGUI_PUBLIC_APP_MAPBOX_TOKEN: 123 as unknown as string,
      }),
    ).toBeUndefined();
  });
});
