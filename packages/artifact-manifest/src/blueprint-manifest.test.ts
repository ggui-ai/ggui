import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  GGUI_BLUEPRINT_JSON_FILENAME,
  blueprintManifestSchema,
  parseBlueprintManifest,
  safeParseBlueprintManifest,
  type BlueprintManifest,
} from './blueprint-manifest.js';

/**
 * Minimal happy-path manifest — only required fields. Validates
 * the smallest declaration a blueprint author must write. Source
 * body kept tiny but non-empty (the schema only enforces
 * non-empty + string at this layer; AST checks land at publish time).
 */
const MINIMAL: BlueprintManifest = {
  kind: 'blueprint',
  scope: '@my-org',
  name: 'weather-card',
  version: '0.1.0',
  visibility: 'public',
  source: 'export default function Card() { return null; }',
};

/**
 * A full, every-optional-field-set manifest. Embeds a minimal
 * DataContract + non-empty variance tags so the protocol-side
 * reused schemas exercise. Contract field set is intentionally
 * small — the protocol's `dataContractSchema` is the source of
 * truth for what's accepted there; this test only verifies it
 * flows through unmodified.
 */
const FULL: BlueprintManifest = {
  kind: 'blueprint',
  scope: '@my-org',
  name: 'weather-card-v2',
  version: '1.2.3-alpha.1+build.42',
  visibility: 'private',
  source: 'export default function Card() { return null; }',
  contract: {
    propsSpec: {
      properties: {
        city: {
          schema: { type: 'string' },
          required: true,
        },
      },
    },
  },
  fixtureProps: { city: 'San Francisco' },
  variance: {
    persona: 'minimalist',
    aesthetic: 'editorial',
    context: { density: 'compact' },
    seedPrompt: 'one-line weather card',
  },
  description: 'A weather card blueprint.',
  tags: ['weather', 'card'],
  author: {
    name: 'Example Inc.',
    email: 'gadgets@example.com',
    url: 'https://example.com',
  },
  license: 'Apache-2.0',
  homepage: 'https://github.com/my-org/weather-card-blueprint',
};

describe('ggui.blueprint.json — filename constant', () => {
  it('is exactly "ggui.blueprint.json"', () => {
    expect(GGUI_BLUEPRINT_JSON_FILENAME).toBe('ggui.blueprint.json');
  });
});

describe('ggui.blueprint.json — happy path', () => {
  it('parses a minimal-required-fields manifest', () => {
    const parsed = parseBlueprintManifest(MINIMAL);
    expect(parsed.kind).toBe('blueprint');
    expect(parsed.scope).toBe('@my-org');
    expect(parsed.name).toBe('weather-card');
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.visibility).toBe('public');
    expect(parsed.source).toContain('export default');
  });

  it('parses a full manifest with every optional field', () => {
    const parsed = parseBlueprintManifest(FULL);
    expect(parsed).toEqual(FULL);
  });

  it('round-trips cleanly through JSON.stringify + re-parse', () => {
    const once = parseBlueprintManifest(FULL);
    const twice = parseBlueprintManifest(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it('safeParse returns success on valid input', () => {
    const result = safeParseBlueprintManifest(MINIMAL);
    expect(result.success).toBe(true);
  });
});

describe('ggui.blueprint.json — kind discriminator', () => {
  it('rejects missing kind', () => {
    const { kind: _kind, ...rest } = MINIMAL;
    const result = safeParseBlueprintManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('kind');
  });

  it('rejects kind="gadget" (wrong literal)', () => {
    const result = safeParseBlueprintManifest({ ...MINIMAL, kind: 'gadget' });
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('kind');
  });

  it('rejects kind="blueprints" (typo)', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      kind: 'blueprints',
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.blueprint.json — required field absences', () => {
  it('rejects missing scope', () => {
    const { scope: _scope, ...rest } = MINIMAL;
    const result = safeParseBlueprintManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('scope');
  });

  it('rejects missing name', () => {
    const { name: _name, ...rest } = MINIMAL;
    const result = safeParseBlueprintManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('name');
  });

  it('rejects missing version', () => {
    const { version: _version, ...rest } = MINIMAL;
    const result = safeParseBlueprintManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('version');
  });

  it('rejects missing visibility', () => {
    const { visibility: _visibility, ...rest } = MINIMAL;
    const result = safeParseBlueprintManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('visibility');
  });

  it('rejects missing source', () => {
    const { source: _source, ...rest } = MINIMAL;
    const result = safeParseBlueprintManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('source');
  });

  it('rejects empty-string source (min(1))', () => {
    const result = safeParseBlueprintManifest({ ...MINIMAL, source: '' });
    expect(result.success).toBe(false);
  });
});

describe('ggui.blueprint.json — identity field shape rules', () => {
  it('rejects scope without leading @', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      scope: 'my-org',
    });
    expect(result.success).toBe(false);
  });

  it('rejects name with uppercase letters', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      name: 'WeatherCard',
    });
    expect(result.success).toBe(false);
  });

  // Bucket B (2026-05-18, LOCKED-25): blueprint + gadget rules
  // unified under `GADGET_NAME_RE` (kebab-case, 2-64 chars). The old
  // accept-set (underscores + single-char) is gone. In-process
  // register-blueprint tightens to the same rule.
  it('rejects name with underscores (unified rule, LOCKED-25)', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      name: 'weather_card_v2',
    });
    expect(result.success).toBe(false);
  });

  it('rejects single-character name (unified rule, LOCKED-25)', () => {
    const result = safeParseBlueprintManifest({ ...MINIMAL, name: 'a' });
    expect(result.success).toBe(false);
  });

  it('rejects name longer than 64 chars', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      name: 'a'.repeat(65),
    });
    expect(result.success).toBe(false);
  });

  it('rejects version "1.0" (not full semver)', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      version: '1.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects visibility outside the enum', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      visibility: 'internal',
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.blueprint.json — variance reuses protocol schema', () => {
  it('accepts a valid variance with every field', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      variance: {
        persona: 'minimalist',
        aesthetic: 'editorial',
        context: { density: 'compact' },
        seedPrompt: 'a tight card',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys inside variance (protocol schema is strict)', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      variance: { persona: 'x', somethingElse: 'oops' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty variance object (all fields optional)', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      variance: {},
    });
    expect(result.success).toBe(true);
  });
});

describe('ggui.blueprint.json — gadget-only fields rejected', () => {
  it('rejects `hook` (gadget-only)', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      hook: 'useCard',
    });
    expect(result.success).toBe(false);
  });

  it('rejects `bundle` (gadget-only)', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      bundle: 'src/index.ts',
    });
    expect(result.success).toBe(false);
  });

  it('rejects `requires` (gadget-only)', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      requires: ['GGUI_PUBLIC_APP_KEY'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects `peerDeps` (gadget-only)', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      peerDeps: { react: '^18.0.0' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects `connect` (gadget-only)', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      connect: ['https://example.com'],
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.blueprint.json — strict unknown-key rejection', () => {
  it('rejects unknown top-level keys', () => {
    const result = safeParseBlueprintManifest({
      ...MINIMAL,
      somethingExtra: 'oops',
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.blueprint.json — type inference', () => {
  it('z.infer<typeof blueprintManifestSchema> matches BlueprintManifest', () => {
    type Inferred = z.infer<typeof blueprintManifestSchema>;
    expectTypeOf<Inferred>().toEqualTypeOf<BlueprintManifest>();
  });
});
