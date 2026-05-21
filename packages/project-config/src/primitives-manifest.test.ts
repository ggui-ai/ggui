import { describe, expect, it } from 'vitest';
import {
  GGUI_PRIMITIVES_JSON_FILENAME,
  parsePrimitivesManifest,
  safeParsePrimitivesManifest,
  type PrimitivesManifest,
} from './primitives-manifest.js';

const baseManifest = {
  schema: '1' as const,
  import: '@ggui-ai/design/primitives',
  primitives: [{ name: 'Button' }, { name: 'Card' }],
};

describe('parsePrimitivesManifest', () => {
  it('accepts the minimal valid manifest', () => {
    const parsed: PrimitivesManifest = parsePrimitivesManifest(baseManifest);
    expect(parsed.schema).toBe('1');
    expect(parsed.import).toBe('@ggui-ai/design/primitives');
    expect(parsed.primitives).toHaveLength(2);
    expect(parsed.primitives[0]?.name).toBe('Button');
    expect(parsed.docs).toBeUndefined();
  });

  it('round-trips JSON.stringify → parse', () => {
    const raw = JSON.stringify({ ...baseManifest, docs: './dist/primitives-llm.md' });
    const parsed = parsePrimitivesManifest(JSON.parse(raw));
    expect(parsed.docs).toBe('./dist/primitives-llm.md');
    // Re-stringify + re-parse must match
    const round = parsePrimitivesManifest(JSON.parse(JSON.stringify(parsed)));
    expect(round).toEqual(parsed);
  });

  it('rejects unknown root keys', () => {
    expect(() =>
      parsePrimitivesManifest({ ...baseManifest, extra: 'nope' }),
    ).toThrow(/unrecognized/i);
  });

  it('rejects unknown per-primitive keys', () => {
    expect(() =>
      parsePrimitivesManifest({
        ...baseManifest,
        primitives: [{ name: 'Button', deprecation: 'soon' }],
      }),
    ).toThrow(/unrecognized/i);
  });

  it('rejects a missing schema field', () => {
    const { schema: _schema, ...rest } = baseManifest;
    expect(() => parsePrimitivesManifest(rest)).toThrow();
  });

  it('rejects schema !== "1"', () => {
    expect(() =>
      parsePrimitivesManifest({ ...baseManifest, schema: '2' }),
    ).toThrow();
  });

  it('rejects empty import string', () => {
    expect(() =>
      parsePrimitivesManifest({ ...baseManifest, import: '' }),
    ).toThrow(/import must not be empty/);
  });

  it('rejects an empty primitives array', () => {
    expect(() =>
      parsePrimitivesManifest({ ...baseManifest, primitives: [] }),
    ).toThrow(/at least one entry/);
  });

  it('rejects duplicate primitive names', () => {
    expect(() =>
      parsePrimitivesManifest({
        ...baseManifest,
        primitives: [{ name: 'Button' }, { name: 'Button' }],
      }),
    ).toThrow(/unique/);
  });

  it('rejects a primitive name that is not a valid JS identifier', () => {
    expect(() =>
      parsePrimitivesManifest({
        ...baseManifest,
        primitives: [{ name: '9Button' }],
      }),
    ).toThrow(/identifier/);
    expect(() =>
      parsePrimitivesManifest({
        ...baseManifest,
        primitives: [{ name: 'Button-One' }],
      }),
    ).toThrow(/identifier/);
    expect(() =>
      parsePrimitivesManifest({
        ...baseManifest,
        primitives: [{ name: 'has space' }],
      }),
    ).toThrow(/identifier/);
  });

  it('accepts identifiers with $ and _ + leading underscore', () => {
    const parsed = parsePrimitivesManifest({
      ...baseManifest,
      primitives: [{ name: '_Button' }, { name: '$Field' }, { name: 'Card_2' }],
    });
    expect(parsed.primitives.map((p) => p.name)).toEqual([
      '_Button',
      '$Field',
      'Card_2',
    ]);
  });

  it('accepts optional docs pointer', () => {
    const parsed = parsePrimitivesManifest({
      ...baseManifest,
      docs: './dist/primitives-llm.md',
    });
    expect(parsed.docs).toBe('./dist/primitives-llm.md');
  });

  it('rejects empty docs pointer', () => {
    expect(() =>
      parsePrimitivesManifest({ ...baseManifest, docs: '' }),
    ).toThrow();
  });
});

describe('safeParsePrimitivesManifest', () => {
  it('returns success=true with parsed data for a valid manifest', () => {
    const result = safeParsePrimitivesManifest(baseManifest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.import).toBe(baseManifest.import);
  });

  it('returns success=false with a ZodError for invalid input', () => {
    const result = safeParsePrimitivesManifest({ nope: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
  });
});

describe('GGUI_PRIMITIVES_JSON_FILENAME', () => {
  it('is the canonical filename', () => {
    expect(GGUI_PRIMITIVES_JSON_FILENAME).toBe('ggui.primitives.json');
  });
});
