import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  artifactManifestSchema,
  parseArtifactManifest,
  safeParseArtifactManifest,
  type ArtifactManifest,
} from './artifact-manifest.js';
import type { GadgetManifest } from './gadget-manifest.js';
import type { BlueprintManifest } from './blueprint-manifest.js';

const VALID_GADGET: GadgetManifest = {
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
      usage: 'Use to surface current weather conditions.',
      example: { city: 'Berlin' },
    },
  ],
};

const VALID_BLUEPRINT: BlueprintManifest = {
  kind: 'blueprint',
  scope: '@my-org',
  name: 'weather-card',
  version: '0.1.0',
  visibility: 'public',
  source: 'export default function Card() { return null; }',
};

describe('artifactManifest — happy path on each kind', () => {
  it('parses a gadget manifest', () => {
    const parsed = parseArtifactManifest(VALID_GADGET);
    expect(parsed.kind).toBe('gadget');
  });

  it('parses a blueprint manifest', () => {
    const parsed = parseArtifactManifest(VALID_BLUEPRINT);
    expect(parsed.kind).toBe('blueprint');
  });

  it('safeParse returns success on either kind', () => {
    expect(safeParseArtifactManifest(VALID_GADGET).success).toBe(true);
    expect(safeParseArtifactManifest(VALID_BLUEPRINT).success).toBe(true);
  });
});

describe('artifactManifest — discriminator narrowing', () => {
  it('narrows TS type via kind after parse — gadget', () => {
    const parsed = parseArtifactManifest(VALID_GADGET);
    if (parsed.kind === 'gadget') {
      // Gadget-only field accessible on the narrowed branch.
      expect(parsed.exports[0]).toMatchObject({
        hook: 'useWeatherCard',
      });
      expect(parsed.bundle).toBe('src/index.ts');
    } else {
      throw new Error('expected gadget branch');
    }
  });

  it('narrows TS type via kind after parse — blueprint', () => {
    const parsed = parseArtifactManifest(VALID_BLUEPRINT);
    if (parsed.kind === 'blueprint') {
      // Blueprint-only field accessible on the narrowed branch.
      expect(parsed.source).toContain('export default');
    } else {
      throw new Error('expected blueprint branch');
    }
  });
});

describe('artifactManifest — discriminator failures', () => {
  it('rejects missing kind with path-["kind"] discriminator issue', () => {
    const { kind: _kind, ...rest } = VALID_GADGET;
    const result = safeParseArtifactManifest(rest);
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('kind');
  });

  it('rejects kind outside the union ("widget")', () => {
    const result = safeParseArtifactManifest({
      ...VALID_GADGET,
      kind: 'widget',
    });
    expect(result.success).toBe(false);
    const paths = result.success
      ? []
      : result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('kind');
  });

  it('throws ZodError for an absent kind', () => {
    const { kind: _kind, ...rest } = VALID_GADGET;
    expect(() => parseArtifactManifest(rest)).toThrow(z.ZodError);
  });
});

describe('artifactManifest — cross-kind field rejection', () => {
  it('rejects a gadget payload carrying blueprint-only `source`', () => {
    const result = safeParseArtifactManifest({
      ...VALID_GADGET,
      source: 'export default null',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a blueprint payload carrying gadget-only `exports` + `bundle`', () => {
    const result = safeParseArtifactManifest({
      ...VALID_BLUEPRINT,
      exports: [
        {
          hook: 'useCard',
          description: 'd',
          usage: 'u',
          example: {},
        },
      ],
      bundle: 'src/index.ts',
    });
    expect(result.success).toBe(false);
  });
});

describe('artifactManifest — type inference', () => {
  it('ArtifactManifest IS the union of GadgetManifest | BlueprintManifest', () => {
    expectTypeOf<ArtifactManifest>().toEqualTypeOf<
      GadgetManifest | BlueprintManifest
    >();
  });

  it('z.infer<typeof artifactManifestSchema> matches ArtifactManifest', () => {
    type Inferred = z.infer<typeof artifactManifestSchema>;
    expectTypeOf<Inferred>().toEqualTypeOf<ArtifactManifest>();
  });
});
