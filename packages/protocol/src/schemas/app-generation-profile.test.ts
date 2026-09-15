import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  APP_GENERATION_PROFILE_BOUNDS,
  appGenerationProfileReadSchema,
  parseAppGenerationProfileAtReadDoor,
  APP_GENERATION_PROFILE_EFFORTS,
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

// ggui#1058 (A2 contract half) — `effort`: one name over the reader's dials; the
// wire carries ONLY the name. Absent ⇒ the deployment's default (today's fixed
// options, byte-identical prompt); an unavailable level is REFUSED at the door
// (`{ profile: { effort: 'unavailable' } }`), never downgraded.
describe('appGenerationProfileSchema.effort (ggui#1058)', () => {
  it('names the five levels exactly, in order, and accepts each', () => {
    expect(APP_GENERATION_PROFILE_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'ultra']);
    for (const effort of APP_GENERATION_PROFILE_EFFORTS) {
      expect(appGenerationProfileSchema.parse({ effort })).toEqual({ effort });
    }
  });

  it('refuses a level outside the vocabulary and a non-string, naming the member', () => {
    for (const bad of ['max', 'HIGH', '', 3, null]) {
      const r = appGenerationProfileSchema.safeParse({ effort: bad });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(['effort']);
    }
  });

  it('is absent-safe: `{}` and the four text members alone parse without an effort', () => {
    expect(appGenerationProfileSchema.parse({ styling: 'x' })).toEqual({ styling: 'x' });
    expect('effort' in appGenerationProfileSchema.parse({})).toBe(false);
  });

  it('the refusal body can name an unavailable level, member-scoped', () => {
    expect(appGenerationProfileRefusalBodySchema.safeParse({ profile: { effort: 'unavailable' } }).success).toBe(true);
    expect(appGenerationProfileRefusalBodySchema.safeParse({ profile: { effort: 'too-long' } }).success).toBe(true);
    expect(appGenerationProfileRefusalBodySchema.safeParse({ profile: { effort: 'downgraded' } }).success).toBe(false);
  });

  it('is representable as JSON Schema with the enum surfaced', () => {
    const js = z.toJSONSchema(appGenerationProfileSchema) as { properties?: Record<string, { enum?: string[] }> };
    expect(js.properties?.['effort']?.enum).toEqual(['low', 'medium', 'high', 'xhigh', 'ultra']);
  });
});

// ggui#1058 — `aesthetic`: a reference into the aesthetic/variance catalogue
// (data, elsewhere). The door validates GRAMMAR only; resolution is at read
// and an unresolvable reference is NON-FATAL (`profile_aesthetic_unresolved`).
describe('appGenerationProfileSchema.aesthetic (ggui#1058)', () => {
  it('accepts a slug id with an optional version and keeps both verbatim', () => {
    expect(appGenerationProfileSchema.parse({ aesthetic: { id: 'hero-fill' } })).toEqual({ aesthetic: { id: 'hero-fill' } });
    expect(appGenerationProfileSchema.parse({ aesthetic: { id: 'a1', version: '2026-09-13.1' } })).toEqual({
      aesthetic: { id: 'a1', version: '2026-09-13.1' },
    });
  });

  it('refuses a non-slug id, a missing id, an unknown key, and a version with whitespace or over 32 chars', () => {
    for (const bad of [{ id: 'Hero Fill' }, { id: '-lead' }, { id: 'a' }, { id: 'x'.repeat(65) }, { version: '1' }, { id: 'hero', tone: 'warm' }, { id: 'hero', version: 'v 1' }, { id: 'hero', version: 'v'.repeat(33) }]) {
      const r = appGenerationProfileSchema.safeParse({ aesthetic: bad });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path[0]).toBe('aesthetic');
    }
  });

  it('is representable as JSON Schema with the id pattern surfaced', () => {
    const js = z.toJSONSchema(appGenerationProfileSchema) as {
      properties?: Record<string, { properties?: Record<string, { pattern?: string }> }>;
    };
    expect(js.properties?.['aesthetic']?.properties?.['id']?.pattern).toBe('^[a-z0-9][a-z0-9-]{1,63}$');
  });
});

// ggui#1105 — the profile READ door. The same stored profile is read two ways
// today: the mint parses it strictly and THROWS on an unknown member
// (`bootstrap-styling.ts:237` — the mint dies), while the judge hand-rolls a
// `.strip()` (`eval-cell.ts:177`). One stored document, two postures, and the
// strict one fails on exactly the member a later release adds. This is the
// third instance of the posture ruled in ggui#1093 / ggui#1115 / ggui#1124:
// a read whose purpose is to INTERPRET state strips unknown members and names
// what it stripped; a read whose purpose is to REPRODUCE state must not strip.
describe('parseAppGenerationProfileAtReadDoor (ggui#1105)', () => {
  const stored = { styling: 'Editorial, warm neutrals.', density: 'compact', effort: 'high' as const };

  it('strips a member this release does not name, keeps the rest, and names what it stripped', () => {
    const r = parseAppGenerationProfileAtReadDoor({ ...stored, futureMember: { any: 'shape' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile).toEqual(stored);
    expect(r.stripped).toEqual(['futureMember']);
  });

  it('reports nothing stripped for a profile this release fully names', () => {
    const r = parseAppGenerationProfileAtReadDoor(stored);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toEqual([]);
    expect(r.profile).toEqual(stored);
  });

  it('still REFUSES what the write door refuses — a bound, a control character, an unavailable level shape', () => {
    const tooLong = { styling: 'a'.repeat(APP_GENERATION_PROFILE_BOUNDS.styling + 1) };
    expect(parseAppGenerationProfileAtReadDoor(tooLong).ok).toBe(false);
    expect(parseAppGenerationProfileAtReadDoor({ styling: `a${String.fromCharCode(7)}b` }).ok).toBe(false);
    expect(parseAppGenerationProfileAtReadDoor({ effort: 'max' }).ok).toBe(false);
    expect(parseAppGenerationProfileAtReadDoor('profile').ok).toBe(false);
    expect(parseAppGenerationProfileAtReadDoor(null).ok).toBe(false);
  });

  it('accepts the empty profile — absent members are not stripped members', () => {
    const r = parseAppGenerationProfileAtReadDoor({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stripped).toEqual([]);
    expect(r.profile).toEqual({});
  });

  it('exports the read SCHEMA too, so a reader that needs the parser alone matches the theme door', () => {
    expect(appGenerationProfileReadSchema.parse({ ...stored, futureMember: 1 })).toEqual(stored);
    expect(appGenerationProfileSchema.safeParse({ ...stored, futureMember: 1 }).success).toBe(false);
  });
});
