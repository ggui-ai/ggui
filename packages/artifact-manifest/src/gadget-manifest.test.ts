import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  GGUI_GADGET_JSON_FILENAME,
  assertGadgetManifestValid,
  parseGadgetManifest,
  gadgetManifestSchema,
  safeParseGadgetManifest,
  type GadgetManifest,
} from './gadget-manifest.js';

/**
 * Minimal happy-path manifest — only the required fields. Validates
 * the smallest declaration a gadget author must write.
 */
const MINIMAL: GadgetManifest = {
  kind: 'gadget',
  scope: '@my-org',
  name: 'weather-card',
  version: '0.1.0',
  bundle: 'src/index.ts',
  visibility: 'public',
  description: 'Renders a weather card.',
  exports: [
    {
      hook: 'useWeatherCard',
      description: 'Renders a weather card.',
      usage: 'Use to display current weather conditions.',
      example: { city: 'Berlin' },
    },
  ],
};

/** A full, every-optional-field-set manifest for exhaustive coverage. */
const FULL: GadgetManifest = {
  kind: 'gadget',
  scope: '@my-org',
  name: 'weather-card',
  version: '1.2.3-alpha.1+build.42',
  bundle: 'src/index.ts',
  visibility: 'public',
  style: 'src/index.css',
  requires: ['GGUI_PUBLIC_APP_API_KEY'],
  peerDeps: { 'leaflet': '^1.9.0' },
  description: 'Renders a weather card via OpenWeatherMap.',
  exports: [
    {
      hook: 'useWeatherCard',
      description: 'Renders a weather card via OpenWeatherMap.',
      usage:
        'Use whenever the agent needs to surface current weather conditions for a city the user mentions.',
      example: { city: 'Berlin', units: 'metric' },
      gotchas:
        'OpenWeatherMap rejects keyless requests with 401; ensure `GGUI_PUBLIC_APP_API_KEY` is set.',
    },
  ],
  tags: ['weather', 'card'],
  author: {
    name: 'Example Inc.',
    email: 'gadgets@example.com',
    url: 'https://example.com',
  },
  license: 'Apache-2.0',
  homepage: 'https://github.com/my-org/weather-card',
  connect: ['https://api.openweathermap.org'],
};

describe('ggui.gadget.json — filename constant', () => {
  it('is exactly "ggui.gadget.json"', () => {
    expect(GGUI_GADGET_JSON_FILENAME).toBe('ggui.gadget.json');
  });
});

describe('ggui.gadget.json — happy path', () => {
  it('parses a minimal-required-fields manifest', () => {
    const parsed = parseGadgetManifest(MINIMAL);
    expect(parsed.scope).toBe('@my-org');
    expect(parsed.name).toBe('weather-card');
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.exports).toHaveLength(1);
    expect(parsed.exports[0]).toMatchObject({
      hook: 'useWeatherCard',
    });
    expect(parsed.bundle).toBe('src/index.ts');
    expect(parsed.visibility).toBe('public');
  });

  it('parses a full manifest with every optional field', () => {
    const parsed = parseGadgetManifest(FULL);
    expect(parsed).toEqual(FULL);
  });

  it('round-trips cleanly through JSON.stringify + re-parse', () => {
    const once = parseGadgetManifest(FULL);
    const twice = parseGadgetManifest(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it('safeParse returns success on valid input', () => {
    const result = safeParseGadgetManifest(MINIMAL);
    expect(result.success).toBe(true);
  });

  it('assertGadgetManifestValid does not throw on valid input', () => {
    expect(() => assertGadgetManifestValid(MINIMAL)).not.toThrow();
  });

  it('assertGadgetManifestValid throws ZodError on invalid input', () => {
    expect(() => assertGadgetManifestValid({})).toThrow(z.ZodError);
  });
});

describe('ggui.gadget.json — kind discriminator', () => {
  it('rejects missing kind', () => {
    const { kind: _kind, ...rest } = MINIMAL;
    const result = safeParseGadgetManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('kind');
  });

  it('rejects kind="blueprint" (wrong literal)', () => {
    const result = safeParseGadgetManifest({ ...MINIMAL, kind: 'blueprint' });
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('kind');
  });

  it('rejects kind="gadgets" (typo)', () => {
    const result = safeParseGadgetManifest({ ...MINIMAL, kind: 'gadgets' });
    expect(result.success).toBe(false);
  });
});

describe('ggui.gadget.json — required field absences', () => {
  it('rejects missing scope with scope-path issue', () => {
    const { scope: _scope, ...rest } = MINIMAL;
    const result = safeParseGadgetManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('scope');
  });

  it('rejects missing name', () => {
    const { name: _name, ...rest } = MINIMAL;
    const result = safeParseGadgetManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('name');
  });

  it('rejects missing version', () => {
    const { version: _version, ...rest } = MINIMAL;
    const result = safeParseGadgetManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('version');
  });

  it('rejects missing exports', () => {
    const { exports: _exports, ...rest } = MINIMAL;
    const result = safeParseGadgetManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('exports');
  });

  it('rejects an empty exports array', () => {
    const result = safeParseGadgetManifest({ ...MINIMAL, exports: [] });
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('exports');
  });

  it('rejects missing bundle', () => {
    const { bundle: _bundle, ...rest } = MINIMAL;
    const result = safeParseGadgetManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('bundle');
  });

  it('rejects missing visibility', () => {
    const { visibility: _visibility, ...rest } = MINIMAL;
    const result = safeParseGadgetManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('visibility');
  });
});

describe('ggui.gadget.json — identity field shape rules', () => {
  it('rejects scope without leading @', () => {
    const result = safeParseGadgetManifest({ ...MINIMAL, scope: 'my-org' });
    expect(result.success).toBe(false);
  });

  it('rejects name with leading @ (scope is a separate field)', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      name: '@weather-card',
    });
    expect(result.success).toBe(false);
  });

  it('rejects name with uppercase letters', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      name: 'WeatherCard',
    });
    expect(result.success).toBe(false);
  });

  it('rejects version "1.0" (not full semver)', () => {
    const result = safeParseGadgetManifest({ ...MINIMAL, version: '1.0' });
    expect(result.success).toBe(false);
  });

  it('rejects version with leading v', () => {
    const result = safeParseGadgetManifest({ ...MINIMAL, version: 'v1.0.0' });
    expect(result.success).toBe(false);
  });

  it('accepts pre-release + build metadata in version', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      version: '1.0.0-alpha.1+build.42',
    });
    expect(result.success).toBe(true);
  });

  it('rejects visibility outside the enum', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      visibility: 'internal',
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.gadget.json — requires regex (GGUI_PUBLIC_APP_*)', () => {
  it('accepts a well-formed GGUI_PUBLIC_APP_* key', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      requires: ['GGUI_PUBLIC_APP_API_KEY'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an out-of-namespace key', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      requires: ['SECRET_API_KEY'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a reserved GGUI_PUBLIC_USER_* key', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      requires: ['GGUI_PUBLIC_USER_TOKEN'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a lowercased key', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      requires: ['GGUI_PUBLIC_APP_api_key'],
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.gadget.json — optional fields type checks', () => {
  it('rejects style with a non-string value', () => {
    const result = safeParseGadgetManifest({ ...MINIMAL, style: 42 });
    expect(result.success).toBe(false);
  });

  it('rejects peerDeps with a non-object value', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      peerDeps: ['leaflet'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects homepage that is not a valid URL', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      homepage: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('rejects author.email that is not a valid email', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      author: { name: 'X', email: 'not-an-email' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects tags with a non-string entry', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      tags: ['weather', 42],
    });
    expect(result.success).toBe(false);
  });

  // Schema-hardening (Bucket A, 2026-05-18, P2-G27).
  it('rejects a tag exceeding 64 chars', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      tags: ['a'.repeat(65)],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 20 tags', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    const result = safeParseGadgetManifest({ ...MINIMAL, tags });
    expect(result.success).toBe(false);
  });

  it('rejects uppercase characters in tag', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      tags: ['Weather'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects underscores or whitespace in tag', () => {
    expect(
      safeParseGadgetManifest({ ...MINIMAL, tags: ['hello_world'] }).success,
    ).toBe(false);
    expect(
      safeParseGadgetManifest({ ...MINIMAL, tags: ['hello world'] }).success,
    ).toBe(false);
  });

  it('accepts exactly 20 well-formed tags', () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
    const result = safeParseGadgetManifest({ ...MINIMAL, tags });
    expect(result.success).toBe(true);
  });
});

describe('ggui.gadget.json — connect spec validation', () => {
  it('accepts a well-formed connect array', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      connect: ['https://api.example.com'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty-string connect entry', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      connect: [''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-array connect value', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      connect: 'https://api.example.com',
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.gadget.json — exports[] shape validation', () => {
  it('accepts a component export', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      exports: [
        {
          component: 'WeatherCard',
          description: 'Renders a weather card.',
          usage: 'GguiSession to display current weather conditions.',
          example: { render: '<WeatherCard />' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a manifest with both a hook and a component export', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      exports: [
        {
          hook: 'useWeatherCard',
          description: 'Resolve weather data.',
          usage: 'Mount to fetch weather.',
          example: { call: 'useWeatherCard()' },
        },
        {
          component: 'WeatherCard',
          description: 'Renders a weather card.',
          usage: 'GguiSession the card.',
          example: { render: '<WeatherCard />' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a hook name that is not use-prefixed', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      exports: [
        {
          hook: 'weatherCard',
          description: 'Renders a weather card.',
          usage: 'Use it.',
          example: {},
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a component name that is not PascalCase', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      exports: [
        {
          component: 'weatherCard',
          description: 'Renders a weather card.',
          usage: 'Use it.',
          example: {},
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an export missing the required teaching text', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      exports: [{ hook: 'useWeatherCard' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an export with neither a hook nor a component name', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      exports: [
        {
          description: 'd',
          usage: 'u',
          example: {},
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside an export', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      exports: [
        {
          hook: 'useWeatherCard',
          description: 'd',
          usage: 'u',
          example: {},
          extra: 'oops',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.gadget.json — strict unknown-key rejection', () => {
  it('rejects unknown top-level keys', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      somethingExtra: 'oops',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside author', () => {
    const result = safeParseGadgetManifest({
      ...MINIMAL,
      author: { name: 'X', extra: 'oops' },
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.gadget.json — type inference', () => {
  it('z.infer<typeof gadgetManifestSchema> matches GadgetManifest', () => {
    type Inferred = z.infer<typeof gadgetManifestSchema>;
    expectTypeOf<Inferred>().toEqualTypeOf<GadgetManifest>();
  });
});
