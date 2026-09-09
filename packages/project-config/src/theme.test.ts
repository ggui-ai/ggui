/**
 * `theme.json` v2 — the authored document (ggui#987 §2, §5, §7).
 *
 * The schema mirrors `@ggui-ai/design`'s `DtcgTheme`: the six layering
 * roles + the five family anchors are authored; ramps, `on*` inks,
 * containers, `elevated` and the type scale are DERIVED by the one
 * producer (`deriveThemeVariables`), so `font.size`, `font.lineHeight`,
 * `motion.duration`, `motion.easing` and `$metadata.fontUrl` are gone —
 * no shim. `normalizeThemeDocument` turns a parsed document into the
 * exact `DtcgTheme` the producer consumes.
 */
import { describe, expect, it } from 'vitest';
import { deriveThemeVariables, lightTheme } from '@ggui-ai/design/themes';
import {
  normalizeThemeDocument,
  parseThemeDocument,
  safeParseThemeDocument,
  type ThemeDocument,
} from './theme.js';

const color = (v: string) => ({ $type: 'color' as const, $value: v });
const dim = (v: string) => ({ $type: 'dimension' as const, $value: v });

/** The minimum valid v2 document: the roles the producer needs, nothing derived. */
const baseTheme: ThemeDocument = {
  color: {
    primary: { '500': color('#0ea5e9') },
    success: { '500': color('#16a34a') },
    warning: { '500': color('#f59e0b') },
    error: { '500': color('#dc2626') },
    info: { '500': color('#2563eb') },
    ground: color('#ffffff'),
    onGround: color('#111827'),
    container: color('#ffffff'),
    onContainer: color('#111827'),
    sunken: color('#f3f4f6'),
    onSunken: color('#374151'),
  },
  spacing: { '4': dim('16px') },
  font: {
    family: { sans: { $type: 'fontFamily', $value: ['Inter', 'system-ui'] } },
    weight: { regular: { $type: 'fontWeight', $value: 400 } },
  },
  shape: {
    radius: { md: dim('8px') },
    shadow: {
      sm: {
        $type: 'shadow',
        $value: { offsetX: '0', offsetY: '1px', blur: '2px', spread: '0', color: 'rgba(0,0,0,.05)' },
      },
    },
  },
};

describe('parseThemeDocument — required groups', () => {
  it('accepts the minimum valid theme', () => {
    const parsed = parseThemeDocument(baseTheme);
    expect(parsed.color.ground.$value).toBe('#ffffff');
    expect(parsed.spacing).toBeDefined();
    expect(parsed.font).toBeDefined();
    expect(parsed.shape).toBeDefined();
  });

  it('accepts optional DTCG metadata ($schema, $version, $name, $description)', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      $schema: 'https://design-tokens.github.io/community-group/format/',
      $version: '1.0.0',
      $name: 'My Brand',
      $description: 'A custom theme for the brand site.',
    });
    expect(parsed.$name).toBe('My Brand');
    expect(parsed.$description).toBe('A custom theme for the brand site.');
  });

  it('accepts the $metadata bag (font, philosophy, frameless) and REJECTS the retired fontUrl', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      $metadata: { font: 'Inter', philosophy: 'Quiet utility.', frameless: true },
    });
    expect(parsed.$metadata?.frameless).toBe(true);
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        $metadata: { font: 'Inter', fontUrl: 'https://fonts.googleapis.com/css2?family=Inter' },
      }),
    ).toThrow();
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parseThemeDocument({ ...baseTheme, mystery: 'nope' })).toThrow(/unrecognized/i);
  });

  it.each(['color', 'font', 'shape', 'spacing'] as const)('rejects a missing %s group', (group) => {
    const rest: Record<string, unknown> = { ...baseTheme };
    delete rest[group];
    expect(() => parseThemeDocument(rest)).toThrow();
  });

  it.each(['ground', 'onGround', 'container', 'onContainer', 'sunken', 'onSunken'] as const)(
    'rejects a missing layering role: %s',
    (role) => {
      const rest: Record<string, unknown> = { ...baseTheme.color };
      delete rest[role];
      expect(() => parseThemeDocument({ ...baseTheme, color: rest })).toThrow();
    },
  );

  it('rejects a missing family palette (success / warning / error / info / primary)', () => {
    const { success: _s, ...rest } = baseTheme.color;
    expect(() => parseThemeDocument({ ...baseTheme, color: rest })).toThrow();
  });

  it('rejects font group missing the required `family.sans` slot', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        font: { ...baseTheme.font, family: { mono: { $type: 'fontFamily', $value: 'JetBrains Mono' } } },
      }),
    ).toThrow();
  });

  it('rejects the retired ladders: font.size, font.lineHeight, motion.duration, motion.easing', () => {
    expect(() =>
      parseThemeDocument({ ...baseTheme, font: { ...baseTheme.font, size: { md: dim('16px') } } }),
    ).toThrow();
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        font: { ...baseTheme.font, lineHeight: { normal: { $type: 'number', $value: 1.5 } } },
      }),
    ).toThrow();
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        motion: { duration: { fast: { $type: 'duration', $value: '150ms' } }, transition: {} },
      }),
    ).toThrow();
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        motion: { easing: { d: { $type: 'cubicBezier', $value: 'cubic-bezier(0,0,1,1)' } }, transition: {} },
      }),
    ).toThrow();
  });

  it('accepts the v2 font additions: family.heading, letterSpacing, the one ramp', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      font: {
        ...baseTheme.font,
        family: { ...baseTheme.font.family, heading: { $type: 'fontFamily', $value: 'Fraunces' } },
        letterSpacing: { heading: dim('-0.02em') },
        ramp: { base: dim('16px'), ratio: { $type: 'number', $value: 1.25 } },
      },
    });
    expect(parsed.font.ramp?.ratio.$value).toBe(1.25);
    expect(parsed.font.family.heading?.$value).toBe('Fraunces');
  });

  it('accepts optional groups: motion (transition + keyframes), accessibility, zIndex, shape.border', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      motion: {
        transition: { default: { $type: 'transition', $value: { duration: '150ms', timingFunction: 'ease-out' } } },
        keyframes: { pulse: { $type: 'string', $value: '@keyframes pulse{}' } },
      },
      zIndex: { modal: { $type: 'number', $value: 1000 } },
      shape: { ...baseTheme.shape, border: { width: dim('1px') } },
      accessibility: {
        focusRing: { color: color('#0ea5e9'), width: dim('2px'), offset: dim('2px') },
        reducedMotion: { duration: { $type: 'duration', $value: '0ms' } },
        highContrast: {
          borderWidth: dim('2px'),
          textColor: color('#000000'),
          backgroundColor: color('#ffffff'),
          linkColor: color('#0000ee'),
        },
      },
    });
    expect(parsed.motion?.keyframes?.pulse?.$value).toBe('@keyframes pulse{}');
    expect(parsed.zIndex?.modal?.$value).toBe(1000);
    expect(parsed.shape.border?.width?.$value).toBe('1px');
    expect(parsed.accessibility?.focusRing?.color.$value).toBe('#0ea5e9');
  });

  it('rejects a partial accessibility sub-group', () => {
    expect(() =>
      parseThemeDocument({ ...baseTheme, accessibility: { focusRing: { color: color('#000') } } }),
    ).toThrow();
  });
});

describe('parseThemeDocument — typography.faces (ggui#987 §5)', () => {
  it('accepts https faces with the optional descriptors', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      typography: {
        faces: [
          { family: 'Acme Sans', src: 'https://fonts.acme.example/acme.woff2', weight: 400, style: 'normal', display: 'swap' },
          { family: 'Acme Sans', src: 'https://fonts.acme.example/acme-bold.woff2', weight: '700' },
        ],
      },
    });
    expect(parsed.typography?.faces).toHaveLength(2);
  });

  it('rejects a face whose src is not https with a well-formed host, or that has no family', () => {
    for (const face of [
      { family: 'A', src: 'http://fonts.acme.example/a.woff2' },
      { family: 'A', src: 'https://localhost/a.woff2' },
      { family: 'A', src: 'data:font/woff2;base64,AAAA' },
      { family: '', src: 'https://fonts.acme.example/a.woff2' },
    ]) {
      expect(() => parseThemeDocument({ ...baseTheme, typography: { faces: [face] } }), JSON.stringify(face)).toThrow();
    }
  });
});

describe('parseThemeDocument — token leaves', () => {
  it('rejects an unknown $type inside a palette (typo guard)', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        color: { ...baseTheme.color, primary: { '500': { $type: 'colour', $value: '#000' } } },
      }),
    ).toThrow();
  });

  it('rejects a dimension token with a non-string $value and a color token with an empty $value', () => {
    expect(() => parseThemeDocument({ ...baseTheme, spacing: { bad: { $type: 'dimension', $value: 16 } } })).toThrow();
    expect(() => parseThemeDocument({ ...baseTheme, color: { ...baseTheme.color, ground: color('') } })).toThrow();
  });

  it('accepts string-form fontFamily and numeric fontWeight within 1–1000', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      font: {
        family: { sans: { $type: 'fontFamily', $value: 'Inter' } },
        weight: { bold: { $type: 'fontWeight', $value: 700 } },
      },
    });
    expect(parsed.font.family.sans.$value).toBe('Inter');
    expect(parsed.font.weight.bold?.$value).toBe(700);
    for (const bogus of [0, 1001]) {
      expect(() =>
        parseThemeDocument({
          ...baseTheme,
          font: { ...baseTheme.font, weight: { bogus: { $type: 'fontWeight', $value: bogus } } },
        }),
      ).toThrow();
    }
  });

  it('accepts structured and string-form shadow $value, and string-form transition', () => {
    expect(typeof parseThemeDocument(baseTheme).shape.shadow.sm?.$value).toBe('object');
    const parsed = parseThemeDocument({
      ...baseTheme,
      shape: { ...baseTheme.shape, shadow: { sm: { $type: 'shadow', $value: '0 1px 2px 0 rgba(0, 0, 0, 0.05)' } } },
      motion: { transition: { default: { $type: 'transition', $value: 'all 200ms ease-out' } } },
    });
    expect(parsed.shape.shadow.sm?.$value).toBe('0 1px 2px 0 rgba(0, 0, 0, 0.05)');
    expect(parsed.motion?.transition.default?.$value).toBe('all 200ms ease-out');
  });

  it('round-trips JSON.stringify → parse', () => {
    const once = parseThemeDocument(JSON.parse(JSON.stringify(baseTheme)));
    const twice = parseThemeDocument(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

describe('normalizeThemeDocument — the parsed document → the exact DtcgTheme the producer consumes', () => {
  it('fills the absent optional groups from the shipped default and names the document', () => {
    const doc = normalizeThemeDocument(parseThemeDocument(baseTheme));
    expect(doc.$name).toBe('custom');
    expect(doc.$description).toBe('');
    expect(doc.motion).toEqual(lightTheme.motion);
    expect(doc.accessibility).toEqual(lightTheme.accessibility);
    expect(doc.zIndex).toEqual(lightTheme.zIndex);
  });

  it('flattens the DTCG object forms to the CSS strings the producer reads', () => {
    const doc = normalizeThemeDocument(
      parseThemeDocument({
        ...baseTheme,
        $schema: 'https://design-tokens.github.io/community-group/format/',
        $version: '1',
        motion: {
          transition: {
            standard: { $type: 'transition', $value: { duration: '120ms', timingFunction: 'ease-in-out' } },
            fade: { $type: 'transition', $value: { property: 'opacity', duration: '80ms', timingFunction: 'linear' } },
          },
        },
      }),
    );
    expect(doc.font.family.sans.$value).toBe('Inter, system-ui');
    expect(doc.font.weight['regular']?.$value).toBe('400');
    expect(doc.shape.shadow['sm']?.$value).toBe('0 1px 2px 0 rgba(0,0,0,.05)');
    expect(doc.motion.transition['standard']?.$value).toBe('all 120ms ease-in-out');
    expect(doc.motion.transition['fade']?.$value).toBe('opacity 80ms linear');
    expect(doc.motion.keyframes).toEqual(lightTheme.motion.keyframes);
    expect('$schema' in doc).toBe(false);
    expect('$version' in doc).toBe(false);
  });

  it('keeps the authored roles + faces verbatim and derives cleanly', () => {
    const doc = normalizeThemeDocument(
      parseThemeDocument({
        ...baseTheme,
        $name: 'Brand',
        typography: { faces: [{ family: 'Acme Sans', src: 'https://fonts.acme.example/a.woff2' }] },
      }),
    );
    expect(doc.$name).toBe('Brand');
    expect(doc.typography?.faces?.[0]?.family).toBe('Acme Sans');
    const vars = deriveThemeVariables(doc, 'light');
    expect(vars['--ggui-color-primary-500']).toBe('#0ea5e9');
    expect(vars['--ggui-color-ground']).toBe('#ffffff');
    expect(vars['--ggui-font-family-sans']).toBe('Inter, system-ui');
  });
});

describe('safeParseThemeDocument', () => {
  it('returns success=true with parsed data for a valid theme', () => {
    const result = safeParseThemeDocument(baseTheme);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.color.primary).toBeDefined();
  });

  it('returns success=false with issues for an invalid theme', () => {
    const result = safeParseThemeDocument({ ...baseTheme, color: {} });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
  });
});
