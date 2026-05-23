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
 *
 * Mirrors the canonical `DtcgTheme` shape: `color`/`font`/`spacing`/
 * `shape` are required; `motion`/`canvas`/`accessibility`/`zIndex`
 * are optional.
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
  font: {
    family: {
      sans: { $type: 'fontFamily', $value: ['Inter', 'system-ui'] },
    },
    size: {
      md: { $type: 'dimension', $value: '16px' },
    },
    weight: {
      regular: { $type: 'fontWeight', $value: 400 },
    },
    lineHeight: {
      normal: { $type: 'number', $value: 1.5 },
    },
  },
  shape: {
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
  },
};

describe('parseThemeDocument — required groups', () => {
  it('accepts the minimum valid theme', () => {
    const parsed = parseThemeDocument(baseTheme);
    expect(parsed.color).toBeDefined();
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
    expect(parsed.$schema).toContain('design-tokens');
    expect(parsed.$version).toBe('1.0.0');
    expect(parsed.$name).toBe('My Brand');
    expect(parsed.$description).toBe('A custom theme for the brand site.');
  });

  it('accepts optional $metadata bag', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      $metadata: {
        font: 'Inter',
        fontUrl: 'https://fonts.googleapis.com/css2?family=Inter',
        philosophy: 'Quiet utility.',
      },
    });
    expect(parsed.$metadata?.font).toBe('Inter');
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

  it('rejects missing font group', () => {
    const { font: _f, ...rest } = baseTheme;
    expect(() => parseThemeDocument(rest)).toThrow();
  });

  it('rejects missing shape group', () => {
    const { shape: _s, ...rest } = baseTheme;
    expect(() => parseThemeDocument(rest)).toThrow();
  });

  it('rejects font group missing required `family.sans` slot', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        font: {
          ...baseTheme.font,
          family: {
            // No `sans` — required by FontGroup.family.
            mono: { $type: 'fontFamily', $value: 'JetBrains Mono' },
          },
        },
      }),
    ).toThrow();
  });

  it('rejects font group missing required sub-records', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        font: { family: baseTheme.font.family },
      }),
    ).toThrow();
  });

  it('rejects shape group missing required sub-records', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        shape: { radius: baseTheme.shape.radius },
      }),
    ).toThrow();
  });

  it('accepts optional groups when present', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      motion: {
        duration: {
          fast: { $type: 'duration', $value: '150ms' },
        },
        transition: {
          default: {
            $type: 'transition',
            $value: { duration: '150ms', timingFunction: 'ease-out' },
          },
        },
      },
      zIndex: {
        modal: { $type: 'number', $value: 1000 },
      },
    });
    expect(parsed.motion?.duration.fast?.$value).toBe('150ms');
    expect(parsed.zIndex?.modal?.$value).toBe(1000);
  });

  it('accepts optional motion sub-records (easing + keyframes)', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      motion: {
        duration: {
          fast: { $type: 'duration', $value: '150ms' },
        },
        easing: {
          default: {
            $type: 'cubicBezier',
            $value: 'cubic-bezier(0.4, 0, 0.2, 1)',
          },
        },
        transition: {
          default: { $type: 'transition', $value: 'all 200ms ease-out' },
        },
        keyframes: {
          pulse: { $type: 'string', $value: 'pulse-keyframes' },
        },
      },
    });
    expect(parsed.motion?.easing?.default?.$value).toContain('cubic-bezier');
    expect(parsed.motion?.keyframes?.pulse).toBeDefined();
  });

  it('accepts an optional canvas group', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      canvas: {
        mode: { $type: 'string', $value: 'wave' },
        speed: { $type: 'number', $value: 1 },
        colors: { $type: 'array', $value: ['#fff', '#000'] },
        background: { $type: 'color', $value: '#0a0a0a' },
      },
    });
    expect(parsed.canvas?.mode.$value).toBe('wave');
  });

  it('round-trips JSON.stringify → parse', () => {
    const raw = JSON.stringify(baseTheme);
    const once = parseThemeDocument(JSON.parse(raw));
    const twice = parseThemeDocument(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

describe('parseThemeDocument — token discriminated union', () => {
  it('rejects unknown $type values inside the color group (typo guard)', () => {
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
      font: {
        ...baseTheme.font,
        family: {
          sans: { $type: 'fontFamily', $value: 'Inter' },
          mono: { $type: 'fontFamily', $value: 'JetBrains Mono' },
        },
      },
    });
    expect(parsed.font.family.mono?.$value).toBe('JetBrains Mono');
  });

  it('accepts numeric fontWeight between 1-1000', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      font: {
        ...baseTheme.font,
        weight: {
          bold: { $type: 'fontWeight', $value: 700 },
        },
      },
    });
    expect(parsed.font.weight.bold?.$value).toBe(700);
  });

  it('rejects fontWeight outside 1-1000', () => {
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        font: {
          ...baseTheme.font,
          weight: {
            bogus: { $type: 'fontWeight', $value: 0 },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseThemeDocument({
        ...baseTheme,
        font: {
          ...baseTheme.font,
          weight: {
            bogus: { $type: 'fontWeight', $value: 1001 },
          },
        },
      }),
    ).toThrow();
  });

  it('accepts string-form transition $value', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      motion: {
        duration: {
          fast: { $type: 'duration', $value: '150ms' },
        },
        transition: {
          default: { $type: 'transition', $value: 'all 200ms ease-out' },
        },
      },
    });
    expect(parsed.motion?.transition.default?.$value).toBe(
      'all 200ms ease-out',
    );
  });

  it('accepts structured shadow $value', () => {
    const parsed = parseThemeDocument(baseTheme);
    const sm = parsed.shape.shadow.sm;
    expect(typeof sm?.$value).toBe('object');
    expect((sm?.$value as { offsetX: string }).offsetX).toBe('0');
  });

  it('accepts string-form shadow $value (registry-theme style)', () => {
    const parsed = parseThemeDocument({
      ...baseTheme,
      shape: {
        ...baseTheme.shape,
        shadow: {
          sm: {
            $type: 'shadow',
            $value: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
          },
        },
      },
    });
    expect(parsed.shape.shadow.sm?.$value).toBe(
      '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
    );
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

  it('accepts semantic roles as either singleton tokens OR palettes', () => {
    // Tools that emit singleton success/warning/error tokens — parses.
    const singletons = parseThemeDocument({
      ...baseTheme,
      color: {
        primary: { '500': { $type: 'color', $value: '#0ea5e9' } },
        success: { $type: 'color', $value: '#16a34a' },
        warning: { $type: 'color', $value: '#f59e0b' },
        error: { $type: 'color', $value: '#dc2626' },
        info: { $type: 'color', $value: '#2563eb' },
      },
    });
    expect(singletons.color.success).toBeDefined();

    // Tools that emit full 50-900 palettes — also parses.
    const scales = parseThemeDocument({
      ...baseTheme,
      color: {
        primary: { '500': { $type: 'color', $value: '#0ea5e9' } },
        success: {
          '500': { $type: 'color', $value: '#16a34a' },
          '700': { $type: 'color', $value: '#15803d' },
        },
      },
    });
    expect(scales.color.success).toBeDefined();
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
