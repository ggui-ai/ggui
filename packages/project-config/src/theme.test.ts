import { describe, expect, it } from 'vitest';
import {
  parseThemeDocument,
  safeParseThemeDocument,
  type ThemeDocument,
} from './theme.js';

/**
 * Minimum valid theme — covers every required group with one token
 * each. Every test case starts from this base and mutates a single
 * field to isolate what's under test.
 */
const baseTheme: ThemeDocument = {
  color: {
    primary: {
      '500': { $type: 'color', $value: '#0ea5e9' },
    },
    surface: { $type: 'color', $value: '#ffffff' },
  },
  spacing: {
    '4': { $type: 'dimension', $value: '16px' },
  },
  typography: {
    fontFamily: {
      sans: { $type: 'fontFamily', $value: ['Inter', 'system-ui'] },
    },
    fontSize: {
      md: { $type: 'dimension', $value: '16px' },
    },
    fontWeight: {
      regular: { $type: 'fontWeight', $value: 400 },
    },
    lineHeight: {
      normal: { $type: 'number', $value: 1.5 },
    },
  },
  radius: {
    md: { $type: 'dimension', $value: '8px' },
  },
  shadow: {
    sm: {
      $type: 'shadow',
      $value: {
        offsetX: '0',
        offsetY: '1px',
        blur: '2px',
        spread: '0',
        color: 'rgba(0,0,0,.05)',
      },
    },
  },
};

describe('parseThemeDocument — required groups', () => {
  it('accepts the minimum valid theme', () => {
    const parsed = parseThemeDocument(baseTheme);
    expect(parsed.color).toBeDefined();
    expect(parsed.spacing).toBeDefined();
    expect(parsed.typography).toBeDefined();
    expect(parsed.radius).toBeDefined();
    expect(parsed.shadow).toBeDefined();
  });

  it('accepts optional DTCG metadata ($schema, $version)', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      $schema: 'https://design-tokens.github.io/community-group/format/',
      $version: '1.0.0',
    });
    expect(parsed.$schema).toContain('design-tokens');
    expect(parsed.$version).toBe('1.0.0');
  });

  it('rejects unknown top-level keys', () => {
    expect(() =>
      parseThemeDocument({ ...baseTheme, mystery: 'nope' }),
    ).toThrow(/unrecognized/i);
  });

  it('rejects missing color group', () => {
    const { color: _c, ...rest } = baseTheme;
    expect(() => parseThemeDocument(rest)).toThrow();
  });

  it('rejects missing typography group', () => {
    const { typography: _t, ...rest } = baseTheme;
    expect(() => parseThemeDocument(rest)).toThrow();
  });

  it('rejects missing required typography sub-groups', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        typography: { fontFamily: baseTheme.typography.fontFamily },
      }),
    ).toThrow();
  });

  it('accepts optional groups when present', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      duration: {
        fast: { $type: 'duration', $value: '150ms' },
      },
      transition: {
        default: {
          $type: 'transition',
          $value: { duration: '150ms', timingFunction: 'ease-out' },
        },
      },
      zIndex: {
        modal: { $type: 'number', $value: 1000 },
      },
    });
    expect(parsed.duration?.fast?.$value).toBe('150ms');
    expect(parsed.zIndex?.modal?.$value).toBe(1000);
  });

  it('round-trips JSON.stringify → parse', () => {
    const raw = JSON.stringify(baseTheme);
    const once = parseThemeDocument(JSON.parse(raw));
    const twice = parseThemeDocument(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

describe('parseThemeDocument — token discriminated union', () => {
  it('rejects unknown $type values (typo guard)', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        color: { bad: { $type: 'colour', $value: '#000' } },
      }),
    ).toThrow();
  });

  it('rejects a dimension token with a non-string $value', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        spacing: { bad: { $type: 'dimension', $value: 16 } },
      }),
    ).toThrow();
  });

  it('rejects a color token with an empty $value', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        color: { bad: { $type: 'color', $value: '' } },
      }),
    ).toThrow();
  });

  it('accepts string-form fontFamily value', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      typography: {
        ...baseTheme.typography,
        fontFamily: {
          mono: { $type: 'fontFamily', $value: 'JetBrains Mono' },
        },
      },
    });
    expect(parsed.typography.fontFamily.mono?.$value).toBe('JetBrains Mono');
  });

  it('accepts numeric fontWeight between 1-1000', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      typography: {
        ...baseTheme.typography,
        fontWeight: {
          bold: { $type: 'fontWeight', $value: 700 },
        },
      },
    });
    expect(parsed.typography.fontWeight.bold?.$value).toBe(700);
  });

  it('rejects fontWeight outside 1-1000', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        typography: {
          ...baseTheme.typography,
          fontWeight: {
            bogus: { $type: 'fontWeight', $value: 0 },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        typography: {
          ...baseTheme.typography,
          fontWeight: {
            bogus: { $type: 'fontWeight', $value: 1001 },
          },
        },
      }),
    ).toThrow();
  });

  it('accepts string-form transition $value', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      transition: {
        default: { $type: 'transition', $value: 'all 200ms ease-out' },
      },
    });
    expect(parsed.transition?.default?.$value).toBe('all 200ms ease-out');
  });

  it('accepts structured shadow $value', () => {
    const parsed = parseThemeDocument(baseTheme);
    const sm = parsed.shadow.sm;
    expect(typeof sm?.$value).toBe('object');
    expect((sm?.$value as { offsetX: string }).offsetX).toBe('0');
  });
});

describe('parseThemeDocument — color group extensibility', () => {
  it('accepts multi-palette color group (primary + accent + semantic roles)', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      color: {
        primary: {
          '500': { $type: 'color', $value: '#0ea5e9' },
        },
        accent: {
          '500': { $type: 'color', $value: '#a855f7' },
        },
        surface: { $type: 'color', $value: '#ffffff' },
        onSurface: { $type: 'color', $value: '#111827' },
      },
    });
    expect(parsed.color.primary).toBeDefined();
    expect(parsed.color.accent).toBeDefined();
    expect(parsed.color.surface).toBeDefined();
  });

  it('rejects color palette with a non-token leaf', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        color: {
          primary: { '500': 'not a token' as unknown as never },
        },
      }),
    ).toThrow();
  });
});

describe('parseThemeDocument — optional accessibility group', () => {
  it('accepts a fully-populated accessibility group', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      accessibility: {
        focusRing: {
          color: { $type: 'color', $value: '#0ea5e9' },
          width: { $type: 'dimension', $value: '2px' },
          offset: { $type: 'dimension', $value: '2px' },
        },
        reducedMotion: {
          duration: { $type: 'duration', $value: '0ms' },
        },
        highContrast: {
          borderWidth: { $type: 'dimension', $value: '2px' },
          textColor: { $type: 'color', $value: '#000000' },
          backgroundColor: { $type: 'color', $value: '#ffffff' },
          linkColor: { $type: 'color', $value: '#0000ee' },
        },
      },
    });
    expect(parsed.accessibility?.focusRing?.color.$value).toBe('#0ea5e9');
  });

  it('rejects partial accessibility sub-groups when malformed', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        accessibility: {
          focusRing: {
            color: { $type: 'color', $value: '#000' },
            // missing width + offset
          },
        },
      } as unknown as never),
    ).toThrow();
  });
});

describe('safeParseThemeDocument', () => {
  it('returns success=true with parsed data for a valid theme', () => {
    const result = safeParseThemeDocument(baseTheme);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.color).toBeDefined();
  });

  it('returns success=false with a ZodError for an invalid theme', () => {
    const result = safeParseThemeDocument({ bogus: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
  });
});
