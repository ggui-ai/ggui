// Slice 2.0 — protocol-side schema tests for `appPublicEnvSchema` +
// `PUBLIC_ENV_APP_KEY_RE`. The schema is the single source of truth
// for App.publicEnv key shape; tests here pin its behavior so every
// downstream consumer (OSS ggui.json parser, cloud AppRecord
// validator, iframe-runtime slice-meta extractors) inherits the
// same rule.

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  BUNDLE_SRI_RE,
  LOOPBACK_HOST_RE,
  NPM_PACKAGE_NAME_RE,
  PUBLIC_ENV_APP_KEY_RE,
  SEMVER_PIN_RE,
  appPublicEnvSchema,
  bundleHostScheme,
  clientCapabilitiesSpecSchema,
  dataContractSchema,
  gadgetDescriptorSchema,
  gadgetExportSchema,
  gadgetExportUseSchema,
  gadgetPackageUseSchema,
  registeredGadgetDescriptorSchema,
  strictGadgetDescriptorSchema,
  strictGadgetExportSchema,
} from './data-contract';

describe('PUBLIC_ENV_APP_KEY_RE', () => {
  it('accepts standard public env keys', () => {
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_APP_MAPBOX_TOKEN')).toBe(true);
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_APP_API_BASE')).toBe(true);
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_APP_TOKEN_2')).toBe(true);
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_APP_A')).toBe(true);
  });

  it('rejects USER_ prefix (reserved for a future per-user channel)', () => {
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_USER_TOKEN')).toBe(false);
  });

  it('rejects non-public prefixes', () => {
    expect(PUBLIC_ENV_APP_KEY_RE.test('MAPBOX_TOKEN')).toBe(false);
    expect(PUBLIC_ENV_APP_KEY_RE.test('APP_TOKEN')).toBe(false);
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PRIVATE_APP_TOKEN')).toBe(false);
    expect(PUBLIC_ENV_APP_KEY_RE.test('PUBLIC_APP_TOKEN')).toBe(false);
  });

  it('rejects lowercase characters in the suffix', () => {
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_APP_mapboxToken')).toBe(false);
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_APP_v2')).toBe(false);
  });

  it('rejects empty suffix', () => {
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_APP_')).toBe(false);
  });

  it('rejects keys with whitespace or punctuation', () => {
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_APP_TOKEN ')).toBe(false);
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_APP_TOKEN-FOO')).toBe(false);
    expect(PUBLIC_ENV_APP_KEY_RE.test('GGUI_PUBLIC_APP_TOKEN.FOO')).toBe(false);
  });
});

describe('appPublicEnvSchema', () => {
  it('accepts an empty map', () => {
    const parsed = appPublicEnvSchema.parse({});
    expect(parsed).toEqual({});
  });

  it('accepts a single well-formed entry', () => {
    const parsed = appPublicEnvSchema.parse({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
    });
    expect(parsed).toEqual({ GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' });
  });

  it('accepts multiple well-formed entries', () => {
    const parsed = appPublicEnvSchema.parse({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
      GGUI_PUBLIC_APP_API_BASE: 'https://api.example.com',
    });
    expect(Object.keys(parsed)).toHaveLength(2);
  });

  it('allows empty-string values (operator-intended absent)', () => {
    // Empty string is meaningful — operator may want the key declared
    // without a value (e.g., not-yet-set placeholder). Rejecting it
    // would force operators to delete the key, losing the
    // documentation of which keys the app expects.
    const parsed = appPublicEnvSchema.parse({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: '',
    });
    expect(parsed).toEqual({ GGUI_PUBLIC_APP_MAPBOX_TOKEN: '' });
  });

  it('rejects a key missing the prefix', () => {
    expect(() =>
      appPublicEnvSchema.parse({ MAPBOX_TOKEN: 'pk.eyJ...' }),
    ).toThrow();
  });

  it('rejects a key with the USER_ prefix (reserved)', () => {
    expect(() =>
      appPublicEnvSchema.parse({ GGUI_PUBLIC_USER_TOKEN: 'pk.eyJ...' }),
    ).toThrow();
  });

  it('rejects lowercase characters in the suffix', () => {
    expect(() =>
      appPublicEnvSchema.parse({ GGUI_PUBLIC_APP_mapbox: 'pk.eyJ...' }),
    ).toThrow();
  });

  it('rejects non-string values', () => {
    expect(() =>
      appPublicEnvSchema.parse({
        GGUI_PUBLIC_APP_TOKEN: 123 as unknown as string,
      }),
    ).toThrow();
  });

  it('rejects the empty-suffix key', () => {
    expect(() =>
      appPublicEnvSchema.parse({ GGUI_PUBLIC_APP_: 'x' }),
    ).toThrow();
  });
});

// Slice 2.0 audit follow-up — symmetry between what wrappers can
// `require` and what `App.publicEnv` can set. A wrapper that asks
// for a key matching the prefix rule will be reachable; a wrapper
// asking for a non-prefix key (typo or arbitrary string) is rejected
// at wrapper-registration time so the misconfig surfaces in
// `createGguiGadget` (or registry validation), not later at
// render-gate validation when the missing key first matters.
describe('gadgetDescriptorSchema — requires prefix enforcement (wire side)', () => {
  it('accepts a wrapper with well-formed requires', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        exports: [{ hook: 'useMapbox' }],
        requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN'],
      }),
    ).not.toThrow();
  });

  it('accepts a wrapper with empty requires', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [{ hook: 'useLeafletMap' }],
        requires: [],
      }),
    ).not.toThrow();
  });

  it('rejects a wrapper whose requires uses an out-of-namespace key', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        exports: [{ hook: 'useMapbox' }],
        requires: ['MAPBOX_TOKEN'],
      }),
    ).toThrow();
  });

  it('rejects a wrapper whose requires uses the reserved USER_ namespace', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@my-org/user',
        version: '0.0.1',
        exports: [{ hook: 'useUser' }],
        requires: ['GGUI_PUBLIC_USER_TOKEN'],
      }),
    ).toThrow();
  });

  it('rejects a wrapper whose requires uses lowercase characters', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@my-org/foo',
        version: '0.0.1',
        exports: [{ hook: 'useFoo' }],
        requires: ['GGUI_PUBLIC_APP_token'],
      }),
    ).toThrow();
  });
});

describe('strictGadgetDescriptorSchema — requires prefix enforcement (registry side)', () => {
  it('accepts a registry wrapper with well-formed requires', () => {
    expect(() =>
      strictGadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        exports: [
          {
            hook: 'useMapbox',
            description: 'Mapbox renderer.',
            usage: 'Mount for maps.',
            example: { center: [0, 0] },
          },
        ],
        requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN'],
        typesUrl: 'https://registry.ggui.ai/types/mapbox.d.ts',
      }),
    ).not.toThrow();
  });

  it('rejects a registry wrapper whose requires uses an out-of-namespace key', () => {
    expect(() =>
      strictGadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        exports: [
          {
            hook: 'useMapbox',
            description: 'Mapbox renderer.',
            usage: 'Mount for maps.',
            example: { center: [0, 0] },
          },
        ],
        requires: ['random_key'],
        typesUrl: 'https://registry.ggui.ai/types/mapbox.d.ts',
      }),
    ).toThrow();
  });
});

// Slice GG.7 — `typesUrl` + `typesSri` carry the wrapper's `.d.ts`
// location + integrity hash. The handler fetches the `.d.ts` at
// render time and loads it into the code-gen sandbox VFS. The
// registry-strict schema REQUIRES `typesUrl` for non-stdlib
// descriptors (decision #6); stdlib is exempt.
describe('gadgetDescriptorSchema — typesUrl / typesSri (Slice GG.7)', () => {
  it('accepts a descriptor carrying typesUrl + typesSri', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@my-org/foo',
        version: '0.0.1',
        exports: [{ hook: 'useFoo' }],
        typesUrl: 'https://registry.ggui.ai/types/@my-org/foo/0.0.1/index.d.ts',
        typesSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
      }),
    ).not.toThrow();
  });

  it('rejects a non-URL typesUrl', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@my-org/foo',
        version: '0.0.1',
        exports: [{ hook: 'useFoo' }],
        typesUrl: 'not-a-url',
      }),
    ).toThrow();
  });

  it('rejects a malformed typesSri', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@my-org/foo',
        version: '0.0.1',
        exports: [{ hook: 'useFoo' }],
        typesUrl: 'https://registry.ggui.ai/types/foo.d.ts',
        typesSri: 'sha256-wrong-algo',
      }),
    ).toThrow();
  });

  it('rejects the retired `signature` field (reserved for crypto)', () => {
    const result = gadgetDescriptorSchema.safeParse({
      package: '@my-org/foo',
      version: '0.0.1',
      exports: [{ hook: 'useFoo' }],
      signature: '(opts?: { x: number }) => number',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys');
    }
  });

  it('wire-permissive schema allows omitting typesUrl', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@scope/foo',
        version: '0.0.1',
        exports: [{ hook: 'useFoo' }],
      }),
    ).not.toThrow();
  });
});

// `strictGadgetDescriptorSchema` is the AUTHOR-time shape check
// (`createGguiGadget` runs it at wrapper module load, before the
// build emits a `.d.ts`) — so it does NOT require `typesUrl`.
// `registeredGadgetDescriptorSchema` is the REGISTRATION-time gate.
describe('strictGadgetDescriptorSchema — typesUrl optional at author time (Slice GG.7)', () => {
  it('accepts a non-stdlib descriptor with NO typesUrl (author-time shape)', () => {
    expect(() =>
      strictGadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [
          {
            hook: 'useLeafletMap',
            description: 'Leaflet renderer.',
            usage: 'Mount for maps.',
            example: { center: [0, 0] },
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe('registeredGadgetDescriptorSchema — typesUrl required for non-stdlib (Slice GG.7)', () => {
  it('accepts a non-stdlib descriptor that declares typesUrl', () => {
    expect(() =>
      registeredGadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [
          {
            hook: 'useLeafletMap',
            description: 'Leaflet renderer.',
            usage: 'Mount for maps.',
            example: { center: [0, 0] },
          },
        ],
        typesUrl:
          'https://registry.ggui.ai/types/@ggui-samples/gadget-leaflet/0.0.1/index.d.ts',
        typesSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
      }),
    ).not.toThrow();
  });

  it('REJECTS a non-stdlib descriptor missing typesUrl', () => {
    const result = registeredGadgetDescriptorSchema.safeParse({
      package: '@ggui-samples/gadget-leaflet',
      version: '0.0.1',
      exports: [
        {
          hook: 'useLeafletMap',
          description: 'Leaflet renderer.',
          usage: 'Mount for maps.',
          example: { center: [0, 0] },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['typesUrl']);
    }
  });

  it('EXEMPTS the first-party stdlib package from the typesUrl requirement', () => {
    expect(() =>
      registeredGadgetDescriptorSchema.parse({
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        exports: [
          {
            hook: 'useGeolocation',
            description: 'Geolocation reader.',
            usage: 'Mount for location.',
            example: { call: 'useGeolocation()' },
          },
        ],
        // No typesUrl — stdlib types load directly in the sandbox.
      }),
    ).not.toThrow();
  });
});

// Slice 3.9 — `bundleSri` flows through the schemas as a permissive
// optional string with regex enforcement. Registry install writes
// it; hand-authored refs omit it. The regex (`BUNDLE_SRI_RE`) pins
// the SRI shape so a malformed value can't sneak past validation
// and end up as a useless `<link integrity>` attribute at runtime.
describe('BUNDLE_SRI_RE', () => {
  it('accepts the publish-Lambda format sha384-<base64>', () => {
    expect(BUNDLE_SRI_RE.test('sha384-abc123XYZ+/==')).toBe(true);
    expect(BUNDLE_SRI_RE.test('sha384-aHR0cDovL2V4YW1wbGUuY29tCg')).toBe(true);
  });

  it('rejects other hash algorithms (we pin sha384 across the protocol)', () => {
    expect(BUNDLE_SRI_RE.test('sha256-abc')).toBe(false);
    expect(BUNDLE_SRI_RE.test('sha512-abc')).toBe(false);
    expect(BUNDLE_SRI_RE.test('md5-abc')).toBe(false);
  });

  it('rejects malformed sha384 strings', () => {
    expect(BUNDLE_SRI_RE.test('sha384-')).toBe(false);
    expect(BUNDLE_SRI_RE.test('sha384abc')).toBe(false);
    expect(BUNDLE_SRI_RE.test('sha384-abc!@#')).toBe(false);
    expect(BUNDLE_SRI_RE.test('')).toBe(false);
  });
});

describe('gadgetDescriptorSchema — bundleSri (Slice 3.9)', () => {
  it('accepts a contract wrapper with a well-formed bundleSri', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        exports: [{ hook: 'useMapbox' }],
        bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
        bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
      }),
    ).not.toThrow();
  });

  it('accepts a contract wrapper without bundleSri (back-compat)', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        exports: [{ hook: 'useMapbox' }],
        bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
      }),
    ).not.toThrow();
  });

  it('rejects a malformed bundleSri at the contract boundary', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        exports: [{ hook: 'useMapbox' }],
        bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
        bundleSri: 'sha256-abc',
      }),
    ).toThrow();
  });
});

describe('strictGadgetDescriptorSchema — bundleSri (Slice 3.9)', () => {
  it('accepts a registry wrapper with a well-formed bundleSri', () => {
    expect(() =>
      strictGadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        exports: [
          {
            hook: 'useMapbox',
            description: 'Mapbox renderer.',
            usage: 'Mount for maps.',
            example: { center: [0, 0] },
          },
        ],
        bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
        bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
        typesUrl: 'https://registry.ggui.ai/types/mapbox.d.ts',
      }),
    ).not.toThrow();
  });

  it('rejects a malformed bundleSri at the registry boundary', () => {
    expect(() =>
      strictGadgetDescriptorSchema.parse({
        package: '@ggui-samples/gadget-mapbox',
        version: '0.0.1',
        exports: [
          {
            hook: 'useMapbox',
            description: 'Mapbox renderer.',
            usage: 'Mount for maps.',
            example: { center: [0, 0] },
          },
        ],
        bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
        bundleSri: 'not-a-hash',
        typesUrl: 'https://registry.ggui.ai/types/mapbox.d.ts',
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bucket A B1 — clientCapabilitiesSpecSchema is .strict()
//
// Pre-launch posture rejects silent drop of unknown sibling fields.
// The retired `libraries` field (renamed to `gadgets` in the 2026-05-18
// rename) and any future stale sibling MUST fail loudly at parse time.
// Without a positive regression test, the next refactor could silently
// re-loosen the schema back to `.passthrough()` and lose the gate.
// ---------------------------------------------------------------------------

describe('clientCapabilitiesSpecSchema — .strict() gate (Bucket A B1)', () => {
  it('parses a valid package-keyed clientCapabilities object', () => {
    // Slice GG.8.8: wire-side `clientCapabilities.gadgets` is
    // PACKAGE-keyed — `Record<package, Record<exportName, …>>`. There
    // is NO `exports` wrapper: a package entry IS its export map. The
    // export NAME is the inner map key; its grammar discriminates
    // kind. `version` + transport metadata (`bundleUrl`, `bundleHost`,
    // `typesUrl`, …) resolve from `App.gadgets`, NOT the wire.
    const parsed = clientCapabilitiesSpecSchema.parse({
      gadgets: {
        '@ggui-samples/gadget-mapbox': { useMapbox: {} },
      },
    });
    const pkg = parsed.gadgets['@ggui-samples/gadget-mapbox'];
    expect(pkg).toBeDefined();
    expect(pkg && 'useMapbox' in pkg).toBe(true);
  });

  it('parses a hook export key and a component export key together', () => {
    const parsed = clientCapabilitiesSpecSchema.parse({
      gadgets: {
        '@my-org/charts': {
          useChartData: {},
          PriceChart: {},
        },
      },
    });
    const pkg = parsed.gadgets['@my-org/charts'];
    expect(pkg).toBeDefined();
    expect(Object.keys(pkg ?? {}).sort()).toEqual([
      'PriceChart',
      'useChartData',
    ]);
  });

  it('REJECTS transport / registry fields inside an export-use object', () => {
    // `gadgetExportUseSchema` is `.strict()` — a transport field
    // (`version`, `bundleUrl`, `permission`, …) on an export-use
    // object fails with `unrecognized_keys`.
    const result = clientCapabilitiesSpecSchema.safeParse({
      gadgets: {
        '@ggui-samples/gadget-mapbox': {
          useMapbox: {
            // Transport / registry field — registry-side only.
            bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('parses an empty gadgets map', () => {
    expect(() => clientCapabilitiesSpecSchema.parse({ gadgets: {} })).not.toThrow();
  });

  it('REJECTS the retired `libraries` sibling field with unrecognized_keys', () => {
    const result = clientCapabilitiesSpecSchema.safeParse({
      gadgets: {},
      libraries: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys');
    }
  });

  it('rejects an arbitrary extra sibling field with unrecognized_keys', () => {
    const result = clientCapabilitiesSpecSchema.safeParse({
      gadgets: {},
      futureField: 'oops',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys');
    }
  });
});

// ---------------------------------------------------------------------------
// LOOPBACK_HOST_RE + bundleHostScheme — anti-lookalike regression
//
// The regex is anchored at both ends so subdomain-prefix attacks
// (`localhost-evil.example.com`, `127.0.0.1.evil.example.com`) cannot
// pose as a local-dev registry and trick callers into emitting `http://`
// for an internet-reachable host. install + render rely on this
// symmetry — a mismatched scheme silently breaks iframe loads under
// mixed-content blocking, so the negative path needs a pinned test.
// ---------------------------------------------------------------------------

describe('LOOPBACK_HOST_RE — accepts genuine loopback hosts', () => {
  it.each([
    'localhost',
    'localhost:8787',
    '127.0.0.1',
    '127.0.0.1:3000',
    '0.0.0.0',
    '0.0.0.0:65535',
  ])('accepts %s', (host) => {
    expect(LOOPBACK_HOST_RE.test(host)).toBe(true);
    expect(bundleHostScheme(host)).toBe('http');
  });
});

describe('LOOPBACK_HOST_RE — rejects anti-lookalike hostnames', () => {
  it.each([
    // Subdomain-prefix attacks — a registry whose hostname starts with
    // the string `localhost` must NOT be treated as loopback.
    'localhost-evil.example.com',
    'localhostevil.example.com',
    'localhost.evil.example.com',
    // Suffix injections on 127.0.0.1
    '127.0.0.1.evil.example.com',
    '127.0.0.1evil.example.com',
    // Embedding loopback strings in the middle / userinfo
    'evil.localhost.example.com',
    'evil-127.0.0.1.example.com',
    // Generic non-loopback hosts
    'registry.ggui.ai',
    'example.com',
  ])('rejects %s', (host) => {
    expect(LOOPBACK_HOST_RE.test(host)).toBe(false);
    expect(bundleHostScheme(host)).toBe('https');
  });
});

// ---------------------------------------------------------------------------
// Slice GG.6 — NPM_PACKAGE_NAME_RE + SEMVER_PIN_RE
//
// `NPM_PACKAGE_NAME_RE` gates the package keys of
// `clientCapabilities.gadgets` (wire side) and the `package` field of
// every `GadgetDescriptor` (registry side); `SEMVER_PIN_RE` pins the
// registry-side `version`. A malformed value would silently corrupt
// the cache. Regexes are pinned at the schema layer; positive +
// negative tests defend against accidental relaxation.
// ---------------------------------------------------------------------------

describe('NPM_PACKAGE_NAME_RE', () => {
  it.each([
    'leaflet',
    'react-router',
    '@ggui-ai/gadgets',
    '@my-org/foo.bar',
    '@my-org/foo_bar',
    'foo123',
  ])('accepts %s', (pkg) => {
    expect(NPM_PACKAGE_NAME_RE.test(pkg)).toBe(true);
  });

  it.each([
    'Leaflet', // uppercase
    '@Scope/foo', // uppercase scope
    '.foo', // leading dot
    '_foo', // leading underscore
    '-foo', // leading hyphen
    '@scope/.foo', // leading dot in name
    '@scope/@other/foo', // multi-scope
    'https://registry.ggui.ai/foo', // URL — registry choice lives on bundleUrl
    'foo bar', // whitespace
    '', // empty
  ])('rejects %s', (pkg) => {
    expect(NPM_PACKAGE_NAME_RE.test(pkg)).toBe(false);
  });
});

describe('SEMVER_PIN_RE', () => {
  it.each([
    '0.0.1',
    '1.2.3',
    '10.20.30',
    '1.2.3-beta.1',
    '2.0.0-rc.1',
    '1.2.3+build.7',
    '1.2.3-beta.1+build.7',
  ])('accepts %s', (ver) => {
    expect(SEMVER_PIN_RE.test(ver)).toBe(true);
  });

  it.each([
    '^0.0.1', // range
    '~1.2.3', // range
    '>=1.0.0', // range
    'v1.2.3', // leading v
    '1.2', // no patch
    '1', // major only
    '1.2.3.4', // four parts
    'latest', // dist-tag
    '*', // wildcard
    '', // empty
  ])('rejects %s', (ver) => {
    expect(SEMVER_PIN_RE.test(ver)).toBe(false);
  });
});

// Slice GG.8.8 — wire-side `clientCapabilities.gadgets` is
// PACKAGE-keyed: `Record<package, GadgetPackageUse>`, each package's
// `exports` keyed by export name. The export NAME is the inner map
// key; its grammar discriminates kind (a `use`-prefixed key is a
// hook, a PascalCase key is a component — grammar-disjoint). `version`
// + transport metadata are NOT on the wire; they resolve from
// `App.gadgets`.
describe('gadgetExportUseSchema — Slice GG.8.8 wire-side per-export use', () => {
  it('accepts an empty export-use object (identity-only reference)', () => {
    expect(() => gadgetExportUseSchema.parse({})).not.toThrow();
  });

  it('accepts optional intent overrides (description, usage)', () => {
    const parsed = gadgetExportUseSchema.parse({
      description: 'Display venue locations on a map.',
      usage: 'Mount for the venue picker screen.',
    });
    expect(parsed.description).toBe('Display venue locations on a map.');
    expect(parsed.usage).toBe('Mount for the venue picker screen.');
  });

  it('REJECTS a transport / registry field on an export-use object', () => {
    // `.strict()` — `version`, `bundleUrl`, `permission`, … are
    // registry-side and fail with `unrecognized_keys`.
    expect(gadgetExportUseSchema.safeParse({ version: '0.0.1' }).success).toBe(
      false,
    );
    expect(
      gadgetExportUseSchema.safeParse({
        bundleUrl: 'https://registry.ggui.ai/bundles/leaflet.js',
      }).success,
    ).toBe(false);
    expect(
      gadgetExportUseSchema.safeParse({ permission: 'geolocation' }).success,
    ).toBe(false);
  });
});

describe('gadgetPackageUseSchema — Slice GG.8.8 wire-side per-package use', () => {
  it('accepts a package use with a single hook export key', () => {
    const parsed = gadgetPackageUseSchema.parse({ useLeafletMap: {} });
    expect('useLeafletMap' in parsed).toBe(true);
  });

  it('accepts a package use with a single component export key', () => {
    const parsed = gadgetPackageUseSchema.parse({ MapView: {} });
    expect('MapView' in parsed).toBe(true);
  });

  it('accepts a hook export key and a component export key together', () => {
    const parsed = gadgetPackageUseSchema.parse({
      useChartData: {},
      PriceChart: {},
    });
    expect(Object.keys(parsed).sort()).toEqual(['PriceChart', 'useChartData']);
  });

  it('rejects an empty package-use map (a package use must declare ≥1)', () => {
    expect(() => gadgetPackageUseSchema.parse({})).toThrow();
  });

  it('rejects a malformed export name (neither hook nor component grammar)', () => {
    // `123bad` is neither a `use`-prefixed hook nor a PascalCase
    // component identifier.
    expect(() => gadgetPackageUseSchema.parse({ '123bad': {} })).toThrow();
  });

  it('rejects a non-`use`-prefixed lowercase export name', () => {
    expect(() => gadgetPackageUseSchema.parse({ leafletMap: {} })).toThrow();
  });

  it('rejects a transport field inside an export-use object', () => {
    expect(
      gadgetPackageUseSchema.safeParse({
        useLeafletMap: { version: '0.0.1' },
      }).success,
    ).toBe(false);
  });
});

describe('clientCapabilitiesSpecSchema — package-keyed gadget map (Slice GG.8.8)', () => {
  it('parses a valid package-keyed gadget map', () => {
    const parsed = clientCapabilitiesSpecSchema.parse({
      gadgets: {
        '@ggui-samples/gadget-leaflet': {
          useLeafletMap: {},
          MapView: {},
        },
      },
    });
    const pkg = parsed.gadgets['@ggui-samples/gadget-leaflet'];
    expect(pkg).toBeDefined();
    expect(Object.keys(pkg ?? {}).sort()).toEqual([
      'MapView',
      'useLeafletMap',
    ]);
  });

  it('rejects a non-package-name top-level key', () => {
    // The top-level key MUST be a valid npm package name
    // (`NPM_PACKAGE_NAME_RE`). A binding-style key like `Map` is no
    // longer permitted.
    expect(() =>
      clientCapabilitiesSpecSchema.parse({
        gadgets: {
          Map: { useLeafletMap: {} },
        },
      }),
    ).toThrow();
  });

  it('rejects a malformed export name inside a package use', () => {
    expect(() =>
      clientCapabilitiesSpecSchema.parse({
        gadgets: {
          '@my-org/foo': { '123bad': {} },
        },
      }),
    ).toThrow();
  });

  it('rejects an empty package-use map for a package', () => {
    expect(() =>
      clientCapabilitiesSpecSchema.parse({
        gadgets: {
          '@my-org/foo': {},
        },
      }),
    ).toThrow();
  });
});

describe('gadgetDescriptorSchema — Slice GG.8.1 package identity required', () => {
  it('rejects a descriptor missing `package`', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        version: '0.0.1',
        exports: [{ hook: 'useFoo' }],
      }),
    ).toThrow();
  });

  it('rejects a descriptor missing `version`', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@my-org/foo',
        exports: [{ hook: 'useFoo' }],
      }),
    ).toThrow();
  });

  it('rejects a descriptor with an empty `exports` array', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@my-org/foo',
        version: '0.0.1',
        exports: [],
      }),
    ).toThrow();
  });

  it('accepts a descriptor that ships a hook and a component export', () => {
    expect(() =>
      gadgetDescriptorSchema.parse({
        package: '@my-org/charts',
        version: '0.0.1',
        exports: [
          { hook: 'useChartData' },
          { component: 'Chart' },
        ],
      }),
    ).not.toThrow();
  });
});

// F1 + F6 — `GadgetExport` is a type-EXCLUSIVE union (`component?: never`
// on the hook member, `hook?: never` on the component member). The schema
// already enforced exclusivity via `.strict()` union members; these tests
// pin both the grammar reject (`HOOK_NAME_RE`) and the both-fields reject
// so a future re-loosening of either schema fails loudly.
describe('gadgetExportSchema — grammar + mutual-exclusion rejects (F6)', () => {
  it('accepts a valid single-field hook export', () => {
    expect(gadgetExportSchema.safeParse({ hook: 'useFoo' }).success).toBe(true);
  });

  it('accepts a valid single-field component export', () => {
    expect(gadgetExportSchema.safeParse({ component: 'Foo' }).success).toBe(
      true,
    );
  });

  it('rejects a hook name that violates HOOK_NAME_RE', () => {
    // `123bad` is neither `use`-prefixed nor a valid identifier.
    expect(gadgetExportSchema.safeParse({ hook: '123bad' }).success).toBe(false);
  });

  it('rejects a both-fields export object {hook, component}', () => {
    // Each union member is `.strict()` — a both-fields object is an
    // extra key on whichever member it tries to match.
    expect(
      gadgetExportSchema.safeParse({ hook: 'useFoo', component: 'Foo' })
        .success,
    ).toBe(false);
  });
});

describe('strictGadgetExportSchema — grammar + mutual-exclusion rejects (F6)', () => {
  it('accepts a valid single-field hook export with teaching text', () => {
    expect(
      strictGadgetExportSchema.safeParse({
        hook: 'useFoo',
        description: 'A foo hook.',
        usage: 'Mount for foo.',
        example: { call: 'useFoo()' },
      }).success,
    ).toBe(true);
  });

  it('rejects a hook name that violates HOOK_NAME_RE', () => {
    expect(
      strictGadgetExportSchema.safeParse({
        hook: '123bad',
        description: 'A foo hook.',
        usage: 'Mount for foo.',
        example: { call: 'useFoo()' },
      }).success,
    ).toBe(false);
  });

  it('rejects a both-fields export object {hook, component}', () => {
    expect(
      strictGadgetExportSchema.safeParse({
        hook: 'useFoo',
        component: 'Foo',
        description: 'A foo export.',
        usage: 'Mount for foo.',
        example: { call: 'useFoo()' },
      }).success,
    ).toBe(false);
  });
});

describe('dataContractSchema — agentCapabilities serverInfo identity', () => {
  it('accepts a serverInfo with name but no version (prefix-derived Tier-2 authoring)', () => {
    const result = dataContractSchema.safeParse({
      agentCapabilities: {
        tools: {
          todo_add: {
            serverInfo: { name: 'todo' },
            toolInfo: { inputSchema: { type: 'object', properties: {} } },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('still rejects a serverInfo with no name', () => {
    const result = dataContractSchema.safeParse({
      agentCapabilities: {
        tools: {
          todo_add: {
            serverInfo: { version: '1.0.0' },
            toolInfo: { inputSchema: { type: 'object', properties: {} } },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
