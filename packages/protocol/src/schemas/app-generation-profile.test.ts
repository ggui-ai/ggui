import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  APP_GENERATION_PROFILE_BOUNDS,
  appGenerationProfileRefusalBodySchema,
  appGenerationProfileSchema,
} from './app-generation-profile';

// ggui#991 — the generator PROFILE slot on the app's `generation` section:
// free text the app's operator writes, the generator reads at generation
// time; never a token, never projected into the card vocabulary.
describe('appGenerationProfileSchema (ggui#991)', () => {
  it('accepts the empty profile and all four members as free text, trimmed', () => {
    expect(appGenerationProfileSchema.parse({})).toEqual({});
    expect(
      appGenerationProfileSchema.parse({
        styling: '  Editorial, warm neutrals.\n\tSerif display, generous whitespace.  ',
        density: ' compact ',
        layout: ' dashboard: KPIs on top, table below ',
        direction: ' brand hero panel, then rows with arrows; no icons, no helper text ',
      }),
    ).toEqual({
      styling: 'Editorial, warm neutrals.\n\tSerif display, generous whitespace.',
      density: 'compact',
      layout: 'dashboard: KPIs on top, table below',
      direction: 'brand hero panel, then rows with arrows; no icons, no helper text',
    });
  });

  it('exports the four door bounds as the ONE set of numbers readers cap at', () => {
    expect(APP_GENERATION_PROFILE_BOUNDS).toEqual({ styling: 2000, density: 200, layout: 200, direction: 600 });
  });

  it('accepts a member at its bound and refuses one character over, naming the member', () => {
    for (const member of ['styling', 'density', 'layout', 'direction'] as const) {
      const max = APP_GENERATION_PROFILE_BOUNDS[member];
      expect(appGenerationProfileSchema.safeParse({ [member]: 'a'.repeat(max) }).success).toBe(true);
      const over = appGenerationProfileSchema.safeParse({ [member]: 'a'.repeat(max + 1) });
      expect(over.success).toBe(false);
      expect(over.error?.issues[0]?.path).toEqual([member]);
    }
  });

  it('accepts the empty string after trim (absent and empty read the same)', () => {
    expect(appGenerationProfileSchema.parse({ styling: '   ' })).toEqual({ styling: '' });
  });

  it('refuses control characters other than newline and tab', () => {
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    const esc = String.fromCharCode(27);
    const del = String.fromCharCode(127);
    const vt = String.fromCharCode(11);
    for (const bad of [`a${nul}b`, `a${bell}b`, `a${esc}b`, `a${del}b`, `a${vt}b`]) {
      expect(appGenerationProfileSchema.safeParse({ styling: bad }).success).toBe(false);
    }
    expect(appGenerationProfileSchema.safeParse({ styling: 'line one\nline\ttwo' }).success).toBe(true);
  });

  it('refuses non-string members and unknown keys (strict object)', () => {
    expect(appGenerationProfileSchema.safeParse({ styling: 42 }).success).toBe(false);
    expect(appGenerationProfileSchema.safeParse({ styling: null }).success).toBe(false);
    expect(appGenerationProfileSchema.safeParse({ tone: 'x' }).success).toBe(false);
    expect(appGenerationProfileSchema.safeParse({ '--ggui-color-primary': '#000' }).success).toBe(false);
  });

  it('is representable as JSON Schema (it ships through tools/list and the docs)', () => {
    expect(() => z.toJSONSchema(appGenerationProfileSchema)).not.toThrow();
    const js = z.toJSONSchema(appGenerationProfileSchema) as {
      properties?: Record<string, { maxLength?: number }>;
    };
    expect(js.properties?.['styling']?.maxLength).toBe(2000);
  });
});

describe('appGenerationProfileRefusalBodySchema (ggui#991)', () => {
  it('names the member and one reason per refusal', () => {
    expect(appGenerationProfileRefusalBodySchema.safeParse({ profile: { styling: 'too-long' } }).success).toBe(true);
    expect(
      appGenerationProfileRefusalBodySchema.safeParse({ profile: { density: 'not-text', layout: 'control-chars', direction: 'too-long' } })
        .success,
    ).toBe(true);
    expect(appGenerationProfileRefusalBodySchema.safeParse({ profile: {} }).success).toBe(false);
    expect(appGenerationProfileRefusalBodySchema.safeParse({ profile: { styling: 'bad' } }).success).toBe(false);
    expect(appGenerationProfileRefusalBodySchema.safeParse({ profile: { tone: 'too-long' } }).success).toBe(false);
  });
});
